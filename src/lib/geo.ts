/** Geometry helpers shared by the map, GPS and tracking layers. */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place extends LatLng {
  address: string;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in metres. Mirrors PostGIS ST_Distance closely enough for UI. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing a -> b, in degrees from north. */
export function bearing(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function isValidLatLng(p: Partial<LatLng> | null | undefined): p is LatLng {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180 &&
    !(p.lat === 0 && p.lng === 0)
  );
}

/** Linear interpolation used to animate the rider marker between GPS fixes. */
export function lerpLatLng(a: LatLng, b: LatLng, t: number): LatLng {
  const k = Math.max(0, Math.min(1, t));
  return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export function boundsOf(points: LatLng[]): Bounds | null {
  const valid = points.filter(isValidLatLng);
  if (!valid.length) return null;
  return valid.reduce<Bounds>(
    (acc, p) => ({
      north: Math.max(acc.north, p.lat),
      south: Math.min(acc.south, p.lat),
      east: Math.max(acc.east, p.lng),
      west: Math.min(acc.west, p.lng),
    }),
    { north: valid[0].lat, south: valid[0].lat, east: valid[0].lng, west: valid[0].lng },
  );
}

/** Google's encoded-polyline format, used by both OSRM and the Routes API. */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }

  return points;
}

/** Straight-line fallback when a routing service is unreachable. */
export function straightLineRoute(from: LatLng, to: LatLng) {
  const distance = haversine(from, to);
  return {
    distance: Math.round(distance * 1.3), // crude road-factor
    duration: Math.round((distance * 1.3) / (30_000 / 3600)), // assume 30 km/h
    geometry: [from, to] as LatLng[],
    approximate: true as const,
  };
}
