import * as React from 'react';
import { isValidLatLng, type LatLng } from '@/lib/geo';

export interface GpsFix extends LatLng {
  accuracy: number | null;
  heading: number | null;
  /** metres per second */
  speed: number | null;
  timestamp: number;
}

export type GpsPermission = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported' | 'insecure';

export interface GeolocationState {
  fix: GpsFix | null;
  permission: GpsPermission;
  error: string | null;
  /** True while a watch is active. */
  watching: boolean;
  /** Ask for permission / take a single reading. */
  request: () => Promise<GpsFix | null>;
}

/**
 * Browsers expose geolocation only in a "secure context".
 *
 * `https://` and `http://localhost` qualify; `http://192.168.x.x` does NOT.
 * That makes LAN testing from a phone fail in a way the generic
 * POSITION_UNAVAILABLE message does nothing to explain, so detect it up front
 * and say so.
 */
function secureContextProblem(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.isSecureContext) return null;
  return (
    `Location needs a secure connection. This page is on ${window.location.protocol}//${window.location.host}, ` +
    `which browsers block. Use http://localhost:5173, or run "npm run dev:https" and open ` +
    `https://${window.location.hostname}:5173 instead.`
  );
}

const HIGH_ACCURACY: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 5_000,
};

// Laptops and desktops have no GPS radio; high accuracy just times out on
// them. Falling back to coarse Wi-Fi positioning is far better than nothing.
const LOW_ACCURACY: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 20_000,
  maximumAge: 60_000,
};

function describeError(e: GeolocationPositionError): string {
  switch (e.code) {
    case e.PERMISSION_DENIED:
      return (
        'Location permission was denied. Click the padlock (or ⓘ) in the address bar, ' +
        'set Location to Allow, then reload.'
      );
    case e.POSITION_UNAVAILABLE:
      return (
        'Your location is unavailable. Turn on location services for your device and browser, ' +
        'then try again.'
      );
    case e.TIMEOUT:
      return 'Finding your location took too long. Move somewhere with a clearer view of the sky and retry.';
    default:
      return e.message || 'Could not determine your location.';
  }
}

/**
 * Browser geolocation with explicit permission state and accuracy filtering.
 *
 * @param watch       keep a live watch open (riders while online; customers no)
 * @param maxAccuracy discard fixes less precise than this many metres, but only
 *                    once a better one has already been seen
 */
export function useGeolocation(watch = false, maxAccuracy = 150): GeolocationState {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const insecure = React.useMemo(secureContextProblem, []);

  const [fix, setFix] = React.useState<GpsFix | null>(null);
  const [permission, setPermission] = React.useState<GpsPermission>(
    !supported ? 'unsupported' : insecure ? 'insecure' : 'unknown',
  );
  const [error, setError] = React.useState<string | null>(insecure);
  const [watching, setWatching] = React.useState(false);

  // Keeps the best fix seen, so one imprecise reading cannot wipe out a good one.
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

      if (next.accuracy != null && next.accuracy > maxAccuracy) {
        const prev = lastGood.current;
        // Discard only if the fix we already hold is actually better. A laptop
        // positioning by Wi-Fi reports several km every time; rejecting those
        // after the first one would freeze the marker permanently.
        if (prev && (prev.accuracy ?? Number.POSITIVE_INFINITY) <= maxAccuracy) {
          return null;
        }
      }

      lastGood.current = next;
      setFix(next);
      setError(null);
      setPermission('granted');
      return next;
    },
    [maxAccuracy],
  );

  // Observe permission state without triggering a prompt, where supported.
  React.useEffect(() => {
    if (!supported || insecure || !navigator.permissions?.query) return;
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
  }, [supported, insecure]);

  const request = React.useCallback(async (): Promise<GpsFix | null> => {
    if (!supported) {
      setError('This browser does not support location services.');
      return null;
    }
    if (insecure) {
      setError(insecure);
      return null;
    }

    const attempt = (options: PositionOptions) =>
      new Promise<GpsFix | null>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (position) => resolve(accept(position) ?? lastGood.current),
          reject,
          options,
        );
      });

    try {
      return await attempt(HIGH_ACCURACY);
    } catch (first) {
      const e = first as GeolocationPositionError;

      // A denial will not be fixed by retrying with different options.
      if (e.code === e.PERMISSION_DENIED) {
        setPermission('denied');
        setError(describeError(e));
        return null;
      }

      // Everything else is worth one coarse retry: this is what makes the app
      // usable on a laptop, which has no GPS radio.
      try {
        return await attempt(LOW_ACCURACY);
      } catch (second) {
        setError(describeError(second as GeolocationPositionError));
        return null;
      }
    }
  }, [supported, insecure, accept]);

  React.useEffect(() => {
    if (!supported || insecure || !watch) return;

    let id = navigator.geolocation.watchPosition(accept, (e) => {
      if (e.code === e.PERMISSION_DENIED) {
        setPermission('denied');
        setError(describeError(e));
        return;
      }
      // Re-open the watch in coarse mode rather than leaving the rider blind.
      navigator.geolocation.clearWatch(id);
      id = navigator.geolocation.watchPosition(accept, (again) => {
        setError(describeError(again as GeolocationPositionError));
      }, LOW_ACCURACY);
    }, HIGH_ACCURACY);

    setWatching(true);

    return () => {
      navigator.geolocation.clearWatch(id);
      setWatching(false);
    };
  }, [supported, insecure, watch, accept]);

  return { fix, permission, error, watching, request };
}
