import { supabase, toAppError, unwrap } from '@/lib/supabase';
import type {
  Booking,
  BookingDispatch,
  BookingEvent,
  BookingStatus,
  BookingWithParties,
  VehicleType,
} from '@/types/database';

export const LIVE_STATUSES: BookingStatus[] = [
  'searching',
  'assigned',
  'rider_arriving',
  'arrived',
  'in_progress',
];

/**
 * Explicit foreign-key hints are required: `bookings` references `profiles`
 * twice (customer_id and cancelled_by), so PostgREST cannot infer the join.
 */
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

export interface CreateBookingInput {
  pickup: { lat: number; lng: number; address: string };
  destination: { lat: number; lng: number; address: string };
  /** metres */
  estimatedDistance: number | null;
  /** seconds */
  estimatedDuration: number | null;
  vehicleType: VehicleType;
  /** Reusing one key makes a retry safe (spec section 15). */
  idempotencyKey: string;
}

export async function createBooking(input: CreateBookingInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_booking', {
    p_pickup_lat: input.pickup.lat,
    p_pickup_lng: input.pickup.lng,
    p_pickup_address: input.pickup.address,
    p_dest_lat: input.destination.lat,
    p_dest_lng: input.destination.lng,
    p_dest_address: input.destination.address,
    p_estimated_distance: input.estimatedDistance,
    p_estimated_duration: input.estimatedDuration,
    p_vehicle_type: input.vehicleType,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw toAppError(error);
  return data as string;
}

export async function cancelBooking(bookingId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_reason: reason ?? null,
  });
  if (error) throw toAppError(error);
}

export async function retryDispatch(bookingId: string): Promise<string> {
  const { data, error } = await supabase.rpc('retry_booking_dispatch', { p_booking_id: bookingId });
  if (error) throw toAppError(error);
  return data as string;
}

export async function advanceStatus(bookingId: string, to: BookingStatus): Promise<BookingStatus> {
  const { data, error } = await supabase.rpc('advance_booking_status', {
    p_booking_id: bookingId,
    p_to: to,
  });
  if (error) throw toAppError(error);
  return data as BookingStatus;
}

export async function fetchBooking(bookingId: string): Promise<BookingWithParties | null> {
  return unwrap(
    await supabase.from('bookings').select(BOOKING_WITH_PARTIES).eq('id', bookingId).maybeSingle(),
  ) as BookingWithParties | null;
}

/** The customer's one live booking, if any. */
export async function fetchActiveCustomerBooking(customerId: string): Promise<BookingWithParties | null> {
  const rows = unwrap(
    await supabase
      .from('bookings')
      .select(BOOKING_WITH_PARTIES)
      .eq('customer_id', customerId)
      .in('status', [...LIVE_STATUSES, 'no_rider_available'])
      .order('created_at', { ascending: false })
      .limit(1),
  ) as BookingWithParties[];
  return rows[0] ?? null;
}

/** The rider's one live booking, if any. */
export async function fetchActiveRiderBooking(riderId: string): Promise<BookingWithParties | null> {
  const rows = unwrap(
    await supabase
      .from('bookings')
      .select(BOOKING_WITH_PARTIES)
      .eq('rider_id', riderId)
      .in('status', ['assigned', 'rider_arriving', 'arrived', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1),
  ) as BookingWithParties[];
  return rows[0] ?? null;
}

export async function fetchBookingHistory(
  column: 'customer_id' | 'rider_id',
  userId: string,
  limit = 40,
): Promise<BookingWithParties[]> {
  return unwrap(
    await supabase
      .from('bookings')
      .select(BOOKING_WITH_PARTIES)
      .eq(column, userId)
      .in('status', ['completed', 'cancelled', 'no_rider_available'])
      .order('created_at', { ascending: false })
      .limit(limit),
  ) as BookingWithParties[];
}

export async function fetchBookingEvents(bookingId: string): Promise<BookingEvent[]> {
  return unwrap(
    await supabase
      .from('booking_events')
      .select('*')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true }),
  ) as BookingEvent[];
}

/** Dispatch ledger for one booking - powers the customer's "contacting riders" view. */
export async function fetchBookingDispatches(bookingId: string): Promise<BookingDispatch[]> {
  return unwrap(
    await supabase
      .from('booking_dispatches')
      .select('*')
      .eq('booking_id', bookingId)
      .order('sequence', { ascending: true }),
  ) as BookingDispatch[];
}

export type { Booking };
