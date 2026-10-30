import { supabase, toAppError, unwrap } from '@/lib/supabase';
import type {
  AdminStats,
  Booking,
  BookingStatus,
  BookingWithParties,
  Profile,
  Rider,
  RiderLocation,
  RiderWithProfile,
  Vehicle,
} from '@/types/database';

const BOOKING_WITH_PARTIES = `
  *,
  customer:profiles!bookings_customer_id_fkey (id, full_name, phone, avatar_url),
  rider:riders!bookings_rider_id_fkey (
    id, availability, is_active, rating, total_rides, license_number,
    unavailable_until, created_at, updated_at,
    profile:profiles!riders_id_fkey (id, full_name, phone, avatar_url),
    vehicles (*)
  )
` as const;

export async function fetchAdminStats(): Promise<AdminStats> {
  const { data, error } = await supabase.rpc('admin_dashboard_stats');
  if (error) throw toAppError(error);
  return data as AdminStats;
}

export async function fetchAllRiders(): Promise<RiderWithProfile[]> {
  const riders = unwrap(
    await supabase
      .from('riders')
      .select(
        `*, profile:profiles!riders_id_fkey (id, full_name, phone, avatar_url), vehicles (*)`,
      )
      .order('created_at', { ascending: false }),
  ) as RiderWithProfile[];

  // Locations are a separate read so the join stays cheap for large fleets.
  const locations = unwrap(await supabase.from('rider_locations').select('*')) as RiderLocation[];
  const byId = new Map(locations.map((l) => [l.rider_id, l]));

  return riders.map((r) => ({ ...r, location: byId.get(r.id) ?? null }));
}

/** Online riders with a position - the live fleet map. */
export async function fetchFleet(): Promise<RiderWithProfile[]> {
  const riders = await fetchAllRiders();
  return riders.filter((r) => r.location != null && r.availability !== 'offline');
}

export async function fetchAdminBookings(
  status: BookingStatus | 'all' | 'active',
  search: string,
): Promise<BookingWithParties[]> {
  let query = supabase.from('bookings').select(BOOKING_WITH_PARTIES);

  if (status === 'active') {
    query = query.in('status', ['searching', 'assigned', 'rider_arriving', 'arrived', 'in_progress']);
  } else if (status !== 'all') {
    query = query.eq('status', status);
  }

  const term = search.trim();
  if (term) {
    // A booking id prefix, or a fragment of either address.
    if (/^[0-9a-f-]{6,}$/i.test(term)) {
      query = query.ilike('id', `${term}%`);
    } else {
      const escaped = term.replace(/[%,()]/g, '');
      query = query.or(
        `pickup_address.ilike.%${escaped}%,destination_address.ilike.%${escaped}%`,
      );
    }
  }

  return unwrap(await query.order('created_at', { ascending: false }).limit(60)) as BookingWithParties[];
}

export async function fetchCustomers(search: string): Promise<Profile[]> {
  let query = supabase.from('profiles').select('*').eq('role', 'customer');
  const term = search.trim();
  if (term) {
    const escaped = term.replace(/[%,()]/g, '');
    query = query.or(`full_name.ilike.%${escaped}%,phone.ilike.%${escaped}%`);
  }
  return unwrap(await query.order('created_at', { ascending: false }).limit(100)) as Profile[];
}

/** Riders eligible for a manual assignment - active and not mid-ride. */
export async function fetchAssignableRiders(): Promise<RiderWithProfile[]> {
  const riders = await fetchAllRiders();
  return riders.filter((r) => r.is_active && r.availability !== 'busy');
}

export async function assignRider(bookingId: string, riderId: string): Promise<string> {
  const { data, error } = await supabase.rpc('admin_assign_rider', {
    p_booking_id: bookingId,
    p_rider_id: riderId,
  });
  if (error) throw toAppError(error);
  return data as string;
}

export async function setRiderActive(riderId: string, active: boolean): Promise<boolean> {
  const { data, error } = await supabase.rpc('admin_set_rider_active', {
    p_rider_id: riderId,
    p_active: active,
  });
  if (error) throw toAppError(error);
  return data as boolean;
}

export interface RiderDetailsInput {
  riderId: string;
  fullName?: string;
  phone?: string;
  licenseNumber?: string;
  vehicleType?: string;
  make?: string;
  model?: string;
  color?: string;
  plateNumber?: string;
  year?: number | null;
}

export async function upsertRiderDetails(input: RiderDetailsInput): Promise<string> {
  const { data, error } = await supabase.rpc('admin_upsert_rider_details', {
    p_rider_id: input.riderId,
    p_full_name: input.fullName ?? null,
    p_phone: input.phone ?? null,
    p_license_number: input.licenseNumber ?? null,
    p_vehicle_type: input.vehicleType ?? null,
    p_make: input.make ?? null,
    p_model: input.model ?? null,
    p_color: input.color ?? null,
    p_plate_number: input.plateNumber ?? null,
    p_year: input.year ?? null,
  });
  if (error) throw toAppError(error);
  return data as string;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const { error } = await supabase.rpc('admin_set_setting', { p_key: key, p_value: value });
  if (error) throw toAppError(error);
}

/**
 * Promotes an existing signed-up account to rider. Creating the auth account
 * itself requires the service-role key and therefore happens in the
 * admin-create-rider Edge Function, never in the browser.
 */
export async function findProfileByName(term: string): Promise<Profile[]> {
  const escaped = term.trim().replace(/[%,()]/g, '');
  if (!escaped) return [];
  return unwrap(
    await supabase
      .from('profiles')
      .select('*')
      .or(`full_name.ilike.%${escaped}%,phone.ilike.%${escaped}%`)
      .limit(20),
  ) as Profile[];
}

export type { Booking, Rider, Vehicle };
