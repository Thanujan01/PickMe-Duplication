import { useQuery } from '@tanstack/react-query';
import { supabase, toAppError, unwrap } from '@/lib/supabase';
import { qk } from '@/lib/query';
import type { AdminSetting } from '@/types/database';

export interface PublicSettings {
  dispatchWindowSeconds: number;
  dispatchRadiusM: number;
  gpsStaleSeconds: number;
  gpsMaxAccuracyM: number;
  searchTimeoutSeconds: number;
  maxDispatchAttempts: number;
  fareBase: number;
  farePerKm: number;
  farePerMin: number;
  allowCustomerCancelAfterAccept: boolean;
}

const DEFAULTS: PublicSettings = {
  dispatchWindowSeconds: 10,
  dispatchRadiusM: 15000,
  gpsStaleSeconds: 45,
  gpsMaxAccuracyM: 10000,
  searchTimeoutSeconds: 180,
  maxDispatchAttempts: 10,
  fareBase: 150,
  farePerKm: 70,
  farePerMin: 4,
  allowCustomerCancelAfterAccept: true,
};

/**
 * Operational tunables the client is allowed to read. The RLS policy on
 * admin_settings whitelists exactly these keys, so nothing sensitive (such as
 * the push relay credentials) can be fetched here.
 */
export function usePublicSettings() {
  return useQuery({
    queryKey: qk.settings(),
    queryFn: async (): Promise<PublicSettings> => {
      const rows = unwrap(await supabase.from('admin_settings').select('key, value')) as Pick<
        AdminSetting,
        'key' | 'value'
      >[];

      const map = new Map(rows.map((r) => [r.key, r.value]));
      const num = (key: string, fallback: number) => {
        const v = Number(map.get(key));
        return Number.isFinite(v) ? v : fallback;
      };

      return {
        dispatchWindowSeconds: num('dispatch_window_seconds', DEFAULTS.dispatchWindowSeconds),
        dispatchRadiusM: num('dispatch_radius_m', DEFAULTS.dispatchRadiusM),
        gpsStaleSeconds: num('gps_stale_seconds', DEFAULTS.gpsStaleSeconds),
        gpsMaxAccuracyM: num('gps_max_accuracy_m', DEFAULTS.gpsMaxAccuracyM),
        searchTimeoutSeconds: num('search_timeout_seconds', DEFAULTS.searchTimeoutSeconds),
        maxDispatchAttempts: num('max_dispatch_attempts', DEFAULTS.maxDispatchAttempts),
        fareBase: num('fare_base', DEFAULTS.fareBase),
        farePerKm: num('fare_per_km', DEFAULTS.farePerKm),
        farePerMin: num('fare_per_min', DEFAULTS.farePerMin),
        allowCustomerCancelAfterAccept:
          map.get('allow_customer_cancel_after_accept') !== false,
      };
    },
    staleTime: 5 * 60_000,
    placeholderData: DEFAULTS,
  });
}

/** Admin-only: every setting, with labels, for the settings screen. */
export function useAllSettings() {
  return useQuery({
    queryKey: ['admin', 'settings', 'all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .order('key', { ascending: true });
      if (error) throw toAppError(error);
      // Fares are still recorded in the database for reporting, but the product
      // does not surface money anywhere, so they are not editable here either.
      return (data as AdminSetting[]).filter((s) => !s.key.startsWith('fare_'));
    },
  });
}
