/**
 * Single place where environment configuration is read and validated.
 *
 * Nothing else in the app touches `import.meta.env`. Missing optional config
 * degrades to a working default; missing *required* config is reported through
 * `configErrors` so the UI can show a setup screen instead of crashing
 * (spec section 9: "show a clear configuration message instead of crashing").
 */

const raw = import.meta.env as Record<string, string | undefined>;

function str(key: string, fallback = ''): string {
  const v = raw[key];
  return v == null || v === '' ? fallback : v.trim();
}

function num(key: string, fallback: number): number {
  const v = Number(raw[key]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(key: string, fallback = false): boolean {
  const v = raw[key];
  if (v == null || v === '') return fallback;
  return v === 'true' || v === '1';
}

export type MapProvider = 'maplibre' | 'google';
export type GeoProvider = 'osm' | 'google';

const mapProvider = (str('VITE_MAP_PROVIDER', 'maplibre') as MapProvider) ?? 'maplibre';
const geoProvider = (str('VITE_GEO_PROVIDER', 'osm') as GeoProvider) ?? 'osm';

export const env = {
  supabaseUrl: str('VITE_SUPABASE_URL'),
  supabaseAnonKey: str('VITE_SUPABASE_ANON_KEY'),

  mapProvider: mapProvider === 'google' ? 'google' : 'maplibre',
  geoProvider: geoProvider === 'google' ? 'google' : 'osm',
  googleMapsApiKey: str('VITE_GOOGLE_MAPS_API_KEY'),
  maplibreStyleUrl: str('VITE_MAPLIBRE_STYLE_URL'),

  defaultCenter: {
    lat: num('VITE_DEFAULT_MAP_LAT', 6.9271),
    lng: num('VITE_DEFAULT_MAP_LNG', 79.8612),
  },
  defaultZoom: num('VITE_DEFAULT_MAP_ZOOM', 13),

  nominatimUrl: str('VITE_NOMINATIM_URL', 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
  osrmUrl: str('VITE_OSRM_URL', 'https://router.project-osrm.org').replace(/\/$/, ''),

  fcm: {
    enabled: bool('VITE_FCM_ENABLED', false),
    apiKey: str('VITE_FIREBASE_API_KEY'),
    authDomain: str('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: str('VITE_FIREBASE_PROJECT_ID'),
    messagingSenderId: str('VITE_FIREBASE_MESSAGING_SENDER_ID'),
    appId: str('VITE_FIREBASE_APP_ID'),
    vapidKey: str('VITE_FIREBASE_VAPID_KEY'),
  },

  isDev: import.meta.env.DEV,
} as const;

/** Blocking misconfiguration. A non-empty array means the app cannot run. */
export const configErrors: string[] = (() => {
  const errors: string[] = [];

  if (!env.supabaseUrl) {
    errors.push('VITE_SUPABASE_URL is not set.');
  } else if (!/^https?:\/\//.test(env.supabaseUrl)) {
    errors.push('VITE_SUPABASE_URL must start with https://');
  }

  if (!env.supabaseAnonKey) {
    errors.push('VITE_SUPABASE_ANON_KEY is not set.');
  }

  if (env.mapProvider === 'google' && !env.googleMapsApiKey) {
    errors.push('VITE_MAP_PROVIDER is "google" but VITE_GOOGLE_MAPS_API_KEY is empty.');
  }

  if (env.geoProvider === 'google' && !env.googleMapsApiKey) {
    errors.push('VITE_GEO_PROVIDER is "google" but VITE_GOOGLE_MAPS_API_KEY is empty.');
  }

  return errors;
})();

/** Non-blocking notes worth surfacing to a developer. */
export const configWarnings: string[] = (() => {
  const warnings: string[] = [];
  if (env.fcm.enabled && !env.fcm.vapidKey) {
    warnings.push('VITE_FCM_ENABLED is true but VITE_FIREBASE_VAPID_KEY is empty; falling back to local notifications.');
  }
  return warnings;
})();

export const fcmConfigured =
  env.fcm.enabled &&
  Boolean(env.fcm.apiKey && env.fcm.projectId && env.fcm.messagingSenderId && env.fcm.appId && env.fcm.vapidKey);
