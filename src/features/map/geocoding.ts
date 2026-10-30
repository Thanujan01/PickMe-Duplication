import { env } from '@/lib/env';
import type { LatLng, Place } from '@/lib/geo';
import { loadGoogleMaps } from './google';

/**
 * Address search and reverse geocoding.
 *
 * Default provider is Nominatim (OpenStreetMap) because it needs no key. Set
 * VITE_GEO_PROVIDER=google to use the Geocoding API instead. Both are wrapped
 * so the rest of the app only ever sees `Place`.
 *
 * Nominatim's usage policy asks for low request rates and no autocomplete-style
 * per-keystroke querying, which is why search is debounced by the caller and
 * results are cached here.
 */

export interface SearchResult extends Place {
  id: string;
  primary: string;
  secondary: string;
}

const searchCache = new Map<string, SearchResult[]>();
const reverseCache = new Map<string, string>();

const reverseKey = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

function splitAddress(label: string): { primary: string; secondary: string } {
  const parts = label.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    primary: parts[0] ?? label,
    secondary: parts.slice(1, 4).join(', '),
  };
}

// --- Nominatim ---------------------------------------------------------------

interface NominatimPlace {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  address?: Record<string, string>;
}

async function nominatimSearch(query: string, near?: LatLng): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '6',
  });

  // Bias results toward the person's current area without hard-filtering.
  if (near) {
    const d = 0.45;
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }

  const res = await fetch(`${env.nominatimUrl}/search?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);

  const json = (await res.json()) as NominatimPlace[];
  return json.map((p) => {
    const { primary, secondary } = splitAddress(p.display_name);
    return {
      id: String(p.place_id),
      lat: Number(p.lat),
      lng: Number(p.lon),
      address: p.display_name,
      primary: p.name || primary,
      secondary,
    };
  });
}

async function nominatimReverse(point: LatLng): Promise<string> {
  const params = new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lng),
    format: 'jsonv2',
    zoom: '18',
    addressdetails: '1',
  });

  const res = await fetch(`${env.nominatimUrl}/reverse?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Reverse geocode failed (${res.status})`);

  const json = (await res.json()) as NominatimPlace & { error?: string };
  if (json.error || !json.display_name) throw new Error('No address found');
  return json.display_name;
}

// --- Google ------------------------------------------------------------------

async function googleSearch(query: string, near?: LatLng): Promise<SearchResult[]> {
  await loadGoogleMaps();
  const geocoder = new google.maps.Geocoder();

  const request: google.maps.GeocoderRequest = { address: query };
  if (near) {
    request.bounds = new google.maps.LatLngBounds(
      { lat: near.lat - 0.4, lng: near.lng - 0.4 },
      { lat: near.lat + 0.4, lng: near.lng + 0.4 },
    );
  }

  const { results } = await geocoder.geocode(request);
  return results.slice(0, 6).map((r) => {
    const { primary, secondary } = splitAddress(r.formatted_address);
    return {
      id: r.place_id,
      lat: r.geometry.location.lat(),
      lng: r.geometry.location.lng(),
      address: r.formatted_address,
      primary,
      secondary,
    };
  });
}

async function googleReverse(point: LatLng): Promise<string> {
  await loadGoogleMaps();
  const geocoder = new google.maps.Geocoder();
  const { results } = await geocoder.geocode({ location: { lat: point.lat, lng: point.lng } });
  if (!results.length) throw new Error('No address found');
  return results[0].formatted_address;
}

// --- Public API --------------------------------------------------------------

export async function searchPlaces(query: string, near?: LatLng): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const key = `${env.geoProvider}:${trimmed.toLowerCase()}:${near ? reverseKey(near) : ''}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  const results =
    env.geoProvider === 'google' ? await googleSearch(trimmed, near) : await nominatimSearch(trimmed, near);

  searchCache.set(key, results);
  if (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value as string);
  return results;
}

/**
 * Coordinates to a human address. Never throws: a dropped pin must stay usable
 * even when the geocoder is down, so the fallback is the coordinate pair.
 */
export async function reverseGeocode(point: LatLng): Promise<string> {
  const key = reverseKey(point);
  const cached = reverseCache.get(key);
  if (cached) return cached;

  try {
    const address = env.geoProvider === 'google' ? await googleReverse(point) : await nominatimReverse(point);
    reverseCache.set(key, address);
    if (reverseCache.size > 150) reverseCache.delete(reverseCache.keys().next().value as string);
    return address;
  } catch {
    return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  }
}
