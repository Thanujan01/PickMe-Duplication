import { supabase, toAppError, unwrap } from '@/lib/supabase';
import type { RiderAvailability, RiderLocation } from '@/types/database';

export async function pushRiderLocation(input: {
  latitude: number;
  longitude: number;
  heading?: number | null;
  speed?: number | null;
  accuracy?: number | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('update_rider_location', {
    p_latitude: input.latitude,
    p_longitude: input.longitude,
    p_heading: input.heading ?? null,
    p_speed: input.speed ?? null,
    p_accuracy: input.accuracy ?? null,
  });
  if (error) throw toAppError(error);
  return data as string;
}

export async function setAvailability(status: RiderAvailability): Promise<RiderAvailability> {
  const { data, error } = await supabase.rpc('set_rider_availability', { p_status: status });
  if (error) throw toAppError(error);
  return data as RiderAvailability;
}

export async function fetchRiderLocation(riderId: string): Promise<RiderLocation | null> {
  return unwrap(
    await supabase.from('rider_locations').select('*').eq('rider_id', riderId).maybeSingle(),
  ) as RiderLocation | null;
}
