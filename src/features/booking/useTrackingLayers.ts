import * as React from 'react';
import { bearing, haversine, isValidLatLng, lerpLatLng, type LatLng } from '@/lib/geo';
import { getRoute } from '@/features/map/routing';
import type { MapMarker, MapRoute } from '@/features/map/types';
import type { BookingWithParties, RiderLocation } from '@/types/database';
import { useRiderLiveLocation } from './hooks';

/**
 * Smooths the rider marker between GPS fixes.
 *
 * Fixes land every few seconds; rendering them raw makes the marker teleport.
 * This eases from the previous position to the new one over ~1.4 s, which is
 * what makes the map feel live (spec section 8: "update rider position
 * smoothly").
 */
function useSmoothedPosition(target: LatLng | null): { position: LatLng | null; heading: number | null } {
  const [position, setPosition] = React.useState<LatLng | null>(target);
  const [heading, setHeading] = React.useState<number | null>(null);
  const animation = React.useRef<number | null>(null);
  const current = React.useRef<LatLng | null>(target);

  React.useEffect(() => {
    if (!target || !isValidLatLng(target)) return;

    const from = current.current;

    // First fix, or a jump big enough that it is a new fix rather than drift.
    if (!from || haversine(from, target) > 2_000) {
      current.current = target;
      setPosition(target);
      return;
    }

    if (haversine(from, target) < 1) return;

    setHeading(bearing(from, target));

    const start = performance.now();
    const duration = 1_400;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out so the marker settles rather than stopping dead
      const eased = 1 - (1 - t) ** 3;
      const next = lerpLatLng(from, target, eased);
      current.current = next;
      setPosition(next);
      if (t < 1) animation.current = requestAnimationFrame(step);
    };

    if (animation.current) cancelAnimationFrame(animation.current);
    animation.current = requestAnimationFrame(step);

    return () => {
      if (animation.current) cancelAnimationFrame(animation.current);
    };
  }, [target]);

  return { position, heading };
}

export interface TrackingLayers {
  markers: MapMarker[];
  routes: MapRoute[];
  fit: LatLng[];
  riderLocation: RiderLocation | null;
  /** Live rider position, interpolated for display. */
  riderPosition: LatLng | null;
  /** Straight-line metres from rider to the relevant target. */
  remainingDistance: number | null;
  /** Seconds, from the routing provider where available. */
  etaSeconds: number | null;
}

/**
 * Everything the map needs while a booking is live.
 *
 * Before pickup the route drawn is rider -> pickup; after the trip starts it is
 * pickup -> destination. The route is only recomputed when the rider has moved
 * a meaningful distance, never on every fix (spec section 9).
 */
export function useTrackingLayers(
  booking: BookingWithParties | null,
  riderId: string | null,
): TrackingLayers {
  const beforePickup =
    booking?.status === 'assigned' ||
    booking?.status === 'rider_arriving' ||
    booking?.status === 'arrived';
  const onTrip = booking?.status === 'in_progress';

  const riderLocation = useRiderLiveLocation(riderId, beforePickup || onTrip);

  const rawRiderPosition = React.useMemo<LatLng | null>(
    () =>
      riderLocation && isValidLatLng({ lat: riderLocation.latitude, lng: riderLocation.longitude })
        ? { lat: riderLocation.latitude, lng: riderLocation.longitude }
        : null,
    [riderLocation],
  );

  const { position: riderPosition, heading: derivedHeading } = useSmoothedPosition(rawRiderPosition);

  const pickup = React.useMemo<LatLng | null>(
    () =>
      booking ? { lat: booking.pickup_latitude, lng: booking.pickup_longitude } : null,
    [booking],
  );

  const destination = React.useMemo<LatLng | null>(
    () =>
      booking
        ? { lat: booking.destination_latitude, lng: booking.destination_longitude }
        : null,
    [booking],
  );

  // --- Route, recomputed only when the rider has actually moved -----------
  const [routePath, setRoutePath] = React.useState<LatLng[]>([]);
  const [etaSeconds, setEtaSeconds] = React.useState<number | null>(null);
  const lastRoutedFrom = React.useRef<LatLng | null>(null);

  React.useEffect(() => {
    if (!booking) {
      setRoutePath([]);
      setEtaSeconds(null);
      return;
    }

    // While searching there is nothing to route yet; show the trip itself.
    if (booking.status === 'searching' || booking.status === 'no_rider_available') {
      if (pickup && destination) {
        let cancelled = false;
        void getRoute(pickup, destination).then((r) => {
          if (!cancelled) {
            setRoutePath(r.geometry);
            setEtaSeconds(null);
          }
        });
        return () => {
          cancelled = true;
        };
      }
      return;
    }

    const from = onTrip ? (riderPosition ?? pickup) : rawRiderPosition;
    const to = onTrip ? destination : pickup;
    if (!from || !to) return;

    // 150 m hysteresis: enough to keep the ETA honest, coarse enough that a
    // rider in traffic does not hammer the routing service.
    const previous = lastRoutedFrom.current;
    if (previous && haversine(previous, from) < 150) return;
    lastRoutedFrom.current = from;

    let cancelled = false;
    void getRoute(from, to).then((r) => {
      if (cancelled) return;
      setRoutePath(r.geometry);
      setEtaSeconds(r.duration);
    });

    return () => {
      cancelled = true;
    };
    // riderPosition is deliberately excluded: it changes every frame while
    // animating. rawRiderPosition (one value per GPS fix) is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.status, booking?.id, rawRiderPosition, pickup, destination, onTrip]);

  const remainingDistance = React.useMemo(() => {
    const from = riderPosition ?? rawRiderPosition;
    const to = onTrip ? destination : pickup;
    if (!from || !to) return null;
    return haversine(from, to);
  }, [riderPosition, rawRiderPosition, onTrip, destination, pickup]);

  const markers = React.useMemo<MapMarker[]>(() => {
    if (!booking) return [];
    const list: MapMarker[] = [];

    if (pickup) {
      list.push({
        id: 'pickup',
        position: pickup,
        kind: 'pickup',
        pulse: booking.status === 'searching' || booking.status === 'arrived',
      });
    }
    if (destination) {
      list.push({ id: 'destination', position: destination, kind: 'destination' });
    }
    if (riderPosition) {
      list.push({
        id: 'rider',
        position: riderPosition,
        kind: 'rider',
        // Prefer the device's compass heading; fall back to travel direction.
        heading: riderLocation?.heading ?? derivedHeading,
        pulse: true,
      });
    }
    return list;
  }, [booking, pickup, destination, riderPosition, riderLocation?.heading, derivedHeading]);

  const routes = React.useMemo<MapRoute[]>(() => {
    if (!routePath.length) return [];
    return [
      {
        id: 'active',
        path: routePath,
        variant: beforePickup ? 'ghost' : 'primary',
      },
    ];
  }, [routePath, beforePickup]);

  const fit = React.useMemo<LatLng[]>(() => {
    const points: LatLng[] = [];
    if (onTrip) {
      if (riderPosition) points.push(riderPosition);
      if (destination) points.push(destination);
    } else if (beforePickup) {
      if (riderPosition) points.push(riderPosition);
      if (pickup) points.push(pickup);
    } else {
      if (pickup) points.push(pickup);
      if (destination) points.push(destination);
    }
    return points;
  }, [onTrip, beforePickup, riderPosition, pickup, destination]);

  return {
    markers,
    routes,
    fit,
    riderLocation,
    riderPosition,
    remainingDistance,
    etaSeconds,
  };
}
