import * as React from 'react';
import { isValidLatLng, type LatLng } from '@/lib/geo';

export interface GpsFix extends LatLng {
  accuracy: number | null;
  heading: number | null;
  /** metres per second */
  speed: number | null;
  timestamp: number;
}

export type GpsPermission = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported';

export interface GeolocationState {
  fix: GpsFix | null;
  permission: GpsPermission;
  error: string | null;
  /** True while a watch is active. */
  watching: boolean;
  /** Ask for permission / take a single reading. */
  request: () => Promise<GpsFix | null>;
}

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 5_000,
};

function describeError(e: GeolocationPositionError): string {
  switch (e.code) {
    case e.PERMISSION_DENIED:
      return 'Location permission was denied. Enable it in your browser settings to continue.';
    case e.POSITION_UNAVAILABLE:
      return 'Your location is unavailable. Check that GPS or location services are on.';
    case e.TIMEOUT:
      return 'Finding your location took too long. Move to an open area and try again.';
    default:
      return e.message || 'Could not determine your location.';
  }
}

/**
 * Browser geolocation with explicit permission state and accuracy filtering.
 *
 * @param watch     keep a live watch open (riders while online, customers no)
 * @param maxAccuracy discard fixes less precise than this many metres
 */
export function useGeolocation(watch = false, maxAccuracy = 150): GeolocationState {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  const [fix, setFix] = React.useState<GpsFix | null>(null);
  const [permission, setPermission] = React.useState<GpsPermission>(
    supported ? 'unknown' : 'unsupported',
  );
  const [error, setError] = React.useState<string | null>(null);
  const [watching, setWatching] = React.useState(false);

  // Keeps the best fix we have seen so a single imprecise reading does not
  // wipe out a good one.
  const lastGood = React.useRef<GpsFix | null>(null);

  const accept = React.useCallback(
    (position: GeolocationPosition) => {
      const next: GpsFix = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy ?? null,
        heading: Number.isFinite(position.coords.heading) ? position.coords.heading : null,
        speed: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
        timestamp: position.timestamp,
      };

      if (!isValidLatLng(next)) return null;

      // Reject a wild reading unless we have nothing at all to show.
      if (next.accuracy != null && next.accuracy > maxAccuracy && lastGood.current) {
        return null;
      }

      lastGood.current = next;
      setFix(next);
      setError(null);
      setPermission('granted');
      return next;
    },
    [maxAccuracy],
  );

  // Observe the permission state without triggering a prompt, where supported.
  React.useEffect(() => {
    if (!supported || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    let active = true;

    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        if (!active) return;
        status = s;
        setPermission(s.state === 'prompt' ? 'prompt' : (s.state as GpsPermission));
        s.onchange = () => {
          if (active) setPermission(s.state === 'prompt' ? 'prompt' : (s.state as GpsPermission));
        };
      })
      .catch(() => {
        /* Safari may reject; fall back to the unknown state. */
      });

    return () => {
      active = false;
      if (status) status.onchange = null;
    };
  }, [supported]);

  const request = React.useCallback(async (): Promise<GpsFix | null> => {
    if (!supported) {
      setError('This browser does not support location services.');
      return null;
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(accept(position) ?? lastGood.current),
        (e) => {
          setError(describeError(e));
          if (e.code === e.PERMISSION_DENIED) setPermission('denied');
          resolve(null);
        },
        GEO_OPTIONS,
      );
    });
  }, [supported, accept]);

  React.useEffect(() => {
    if (!supported || !watch) return;

    const id = navigator.geolocation.watchPosition(accept, (e) => {
      setError(describeError(e));
      if (e.code === e.PERMISSION_DENIED) setPermission('denied');
    }, GEO_OPTIONS);

    setWatching(true);

    return () => {
      navigator.geolocation.clearWatch(id);
      setWatching(false);
    };
  }, [supported, watch, accept]);

  return { fix, permission, error, watching, request };
}
