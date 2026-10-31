import * as React from 'react';
import { haversine } from '@/lib/geo';
import { pushRiderLocation } from './api';
import { useGeolocation, type GpsFix } from './useGeolocation';

/**
 * Writes a rider's position to the database while they are online.
 *
 * Spec section 8 asks for roughly 5-second updates *when movement is detected*
 * and no unnecessary writes while stationary. The rules below implement that:
 *
 *   - never write more often than MIN_INTERVAL_MS
 *   - write when the rider has moved more than MIN_MOVE_M
 *   - otherwise write a heartbeat every HEARTBEAT_MS so `last_seen` stays
 *     fresh and dispatch keeps considering them eligible
 *
 * Writes are fire-and-forget with respect to the UI: a failed update is
 * retried by the next tick, and repeated failures are surfaced so the rider
 * knows their position is not reaching the platform.
 */

const MIN_INTERVAL_MS = 5_000;
const MIN_MOVE_M = 25;
const HEARTBEAT_MS = 20_000;

export interface RiderTrackerState {
  fix: GpsFix | null;
  permission: ReturnType<typeof useGeolocation>['permission'];
  gpsError: string | null;
  /** Last time a write reached the database. */
  lastSyncedAt: number | null;
  syncError: string | null;
  requestPermission: () => Promise<GpsFix | null>;
}

export function useRiderTracker(enabled: boolean): RiderTrackerState {
  // Deliberately generous: update_rider_location() owns the real limit
  // (gps_max_accuracy_m) and reports it in its error. A second, stricter
  // client-side threshold would silently drop fixes the server would accept.
  const { fix, permission, error: gpsError, request } = useGeolocation(enabled, 2000);

  const [lastSyncedAt, setLastSyncedAt] = React.useState<number | null>(null);
  const [syncError, setSyncError] = React.useState<string | null>(null);

  const lastSent = React.useRef<{ fix: GpsFix; at: number } | null>(null);
  const sending = React.useRef(false);
  const failures = React.useRef(0);

  React.useEffect(() => {
    if (!enabled) {
      lastSent.current = null;
      failures.current = 0;
      setSyncError(null);
      return;
    }
    if (!fix || sending.current) return;

    const now = Date.now();
    const previous = lastSent.current;

    if (previous) {
      const sinceMs = now - previous.at;
      if (sinceMs < MIN_INTERVAL_MS) return;

      const moved = haversine(previous.fix, fix);
      if (moved < MIN_MOVE_M && sinceMs < HEARTBEAT_MS) return;
    }

    sending.current = true;
    void pushRiderLocation({
      latitude: fix.lat,
      longitude: fix.lng,
      heading: fix.heading,
      speed: fix.speed,
      accuracy: fix.accuracy,
    })
      .then(() => {
        lastSent.current = { fix, at: Date.now() };
        failures.current = 0;
        setLastSyncedAt(Date.now());
        setSyncError(null);
      })
      .catch((e: unknown) => {
        failures.current += 1;
        // One dropped request on mobile data is normal; three is a problem.
        if (failures.current >= 3) {
          setSyncError(
            e instanceof Error ? e.message : 'Your location is not reaching the server.',
          );
        }
      })
      .finally(() => {
        sending.current = false;
      });
  }, [enabled, fix]);

  // While stationary the watch may not fire at all, so drive the heartbeat from
  // a timer as well as from new fixes.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => forceTick((n) => n + 1), HEARTBEAT_MS / 2);
    return () => clearInterval(timer);
  }, [enabled]);

  return { fix, permission, gpsError, lastSyncedAt, syncError, requestPermission: request };
}
