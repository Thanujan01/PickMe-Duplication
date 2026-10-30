import { env } from '@/lib/env';
import { decodePolyline, straightLineRoute, type LatLng } from '@/lib/geo';
import { loadGoogleMaps } from './google';

/**
 * Route calculation.
 *
 * Default provider is the public OSRM demo server (free, no key). Set
 * VITE_GEO_PROVIDER=google to use the Routes API instead.
 *
 * Spec section 9: "Do not repeatedly call the Routes API for every GPS update."
 * Two mechanisms enforce that here:
 *   1. results are cached on coordinates rounded to ~100 m, so a rider moving
 *      slowly reuses the previous answer;
 *   2. in-flight requests for the same key are shared.
 */

export interface RouteResult {
  /** metres */
  distance: number;
  /** seconds */
  duration: number;
  geometry: LatLng[];
  /** True when this is a straight-line fallback, not a real road route. */
  approximate: boolean;
}

const cache = new Map<string, RouteResult>();
const inFlight = new Map<string, Promise<RouteResult>>();

/** ~100 m buckets: fine enough for an ETA, coarse enough to stop request spam. */
function cacheKey(from: LatLng, to: LatLng): string {
  const r = (n: number) => n.toFixed(3);
  return `${env.geoProvider}:${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`;
}

async function osrmRoute(from: LatLng, to: LatLng): Promise<RouteResult> {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `${env.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=polyline&alternatives=false&steps=false`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Routing failed (${res.status})`);

    const json = (await res.json()) as {
      code: string;
      routes?: { distance: number; duration: number; geometry: string }[];
    };

    const route = json.routes?.[0];
    if (json.code !== 'Ok' || !route) throw new Error('No route found');

    return {
      distance: Math.round(route.distance),
      duration: Math.round(route.duration),
      geometry: decodePolyline(route.geometry),
      approximate: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function googleRoute(from: LatLng, to: LatLng): Promise<RouteResult> {
  await loadGoogleMaps();
  const service = new google.maps.DirectionsService();

  const result = await service.route({
    origin: { lat: from.lat, lng: from.lng },
    destination: { lat: to.lat, lng: to.lng },
    travelMode: google.maps.TravelMode.DRIVING,
  });

  const leg = result.routes[0]?.legs[0];
  if (!leg) throw new Error('No route found');

  return {
    distance: Math.round(leg.distance?.value ?? 0),
    duration: Math.round(leg.duration?.value ?? 0),
    geometry: (result.routes[0].overview_path ?? []).map((p) => ({ lat: p.lat(), lng: p.lng() })),
    approximate: false,
  };
}

/**
 * Road route between two points. Falls back to a straight line with a road
 * factor rather than failing, so the UI always has a distance and an ETA.
 */
export async function getRoute(from: LatLng, to: LatLng): Promise<RouteResult> {
  const key = cacheKey(from, to);

  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const result = env.geoProvider === 'google' ? await googleRoute(from, to) : await osrmRoute(from, to);
      cache.set(key, result);
      if (cache.size > 120) cache.delete(cache.keys().next().value as string);
      return result;
    } catch {
      // Degrade, do not break: an approximate estimate beats a broken screen.
      return straightLineRoute(from, to);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/** Google Maps turn-by-turn hand-off for riders (spec section 6). */
export function navigationUrl(to: LatLng, from?: LatLng): string {
  const params = new URLSearchParams({
    api: '1',
    destination: `${to.lat},${to.lng}`,
    travelmode: 'driving',
  });
  if (from) params.set('origin', `${from.lat},${from.lng}`);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
