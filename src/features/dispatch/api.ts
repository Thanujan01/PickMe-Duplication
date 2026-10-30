import { supabase, toAppError, unwrap } from '@/lib/supabase';
import type { Booking, BookingDispatch, Rider, Vehicle } from '@/types/database';

export interface RiderOffer {
  dispatch: BookingDispatch;
  booking: Booking;
  customerName: string;
}

/**
 * The rider's single open offer, if one exists.
 *
 * `expires_at` is the server's deadline. The UI counts down against it for
 * display only - acceptance is validated server-side, so a client with a
 * skewed clock cannot gain or lose the race (spec section 7, section 21.6).
 */
export async function fetchCurrentOffer(riderId: string): Promise<RiderOffer | null> {
  const dispatches = unwrap(
    await supabase
      .from('booking_dispatches')
      .select('*')
      .eq('rider_id', riderId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('offered_at', { ascending: false })
      .limit(1),
  ) as BookingDispatch[];

  const dispatch = dispatches[0];
  if (!dispatch) return null;

  const booking = unwrap(
    await supabase
      .from('bookings')
      .select('*, customer:profiles!bookings_customer_id_fkey (full_name)')
      .eq('id', dispatch.booking_id)
      .maybeSingle(),
  ) as (Booking & { customer: { full_name: string } | null }) | null;

  // The booking may have been taken or cancelled between the two reads.
  if (!booking || booking.status !== 'searching') return null;

  return {
    dispatch,
    booking,
    customerName: booking.customer?.full_name || 'Customer',
  };
}

export async function acceptBooking(bookingId: string): Promise<string> {
  const { data, error } = await supabase.rpc('accept_booking', { p_booking_id: bookingId });
  if (error) throw toAppError(error);
  return data as string;
}

export async function rejectBooking(bookingId: string): Promise<void> {
  const { error } = await supabase.rpc('reject_booking', { p_booking_id: bookingId });
  if (error) throw toAppError(error);
}

export async function fetchMyRider(riderId: string): Promise<Rider | null> {
  return unwrap(
    await supabase.from('riders').select('*').eq('id', riderId).maybeSingle(),
  ) as Rider | null;
}

export async function fetchMyVehicles(riderId: string): Promise<Vehicle[]> {
  return unwrap(
    await supabase
      .from('vehicles')
      .select('*')
      .eq('rider_id', riderId)
      .order('is_primary', { ascending: false }),
  ) as Vehicle[];
}

export async function fetchRiderStats() {
  const { data, error } = await supabase.rpc('rider_dashboard_stats');
  if (error) throw toAppError(error);
  return data as {
    rides_today: number;
    rides_total: number;
    earnings_today: number;
    earnings_total: number;
    rating: number | null;
    acceptance_rate: number | null;
  };
}

/** Offers this rider has already answered - the "recent requests" list. */
export async function fetchRecentOffers(riderId: string, limit = 15): Promise<BookingDispatch[]> {
  return unwrap(
    await supabase
      .from('booking_dispatches')
      .select('*')
      .eq('rider_id', riderId)
      .neq('status', 'pending')
      .order('offered_at', { ascending: false })
      .limit(limit),
  ) as BookingDispatch[];
}
