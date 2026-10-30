import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { qk } from '@/lib/query';
import { useAuth } from '@/features/auth/AuthProvider';
import type { BookingStatus, BookingWithParties, RiderLocation } from '@/types/database';
import {
  advanceStatus,
  cancelBooking,
  createBooking,
  fetchActiveCustomerBooking,
  fetchActiveRiderBooking,
  fetchBooking,
  fetchBookingDispatches,
  fetchBookingEvents,
  fetchBookingHistory,
  retryDispatch,
  type CreateBookingInput,
} from './api';

/**
 * Realtime is the primary refresh mechanism; `refetchInterval` below is a
 * safety net for a dropped websocket, not the main path.
 */

export function useActiveCustomerBooking() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;

  const query = useQuery({
    queryKey: qk.activeBooking(),
    queryFn: () => fetchActiveCustomerBooking(userId as string),
    enabled: !!userId,
    // Dispatch moves every 10s; poll as a fallback while a search is live.
    refetchInterval: (q) => (q.state.data?.status === 'searching' ? 5_000 : false),
  });

  React.useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`customer-bookings-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings', filter: `customer_id=eq.${userId}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: qk.activeBooking() });
          void queryClient.invalidateQueries({ queryKey: qk.bookingHistory('customer') });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  return query;
}

export function useActiveRiderBooking() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;

  const query = useQuery({
    queryKey: ['booking', 'rider-active'],
    queryFn: () => fetchActiveRiderBooking(userId as string),
    enabled: !!userId,
  });

  React.useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`rider-bookings-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings', filter: `rider_id=eq.${userId}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['booking', 'rider-active'] });
          void queryClient.invalidateQueries({ queryKey: qk.riderStats() });
          void queryClient.invalidateQueries({ queryKey: qk.bookingHistory('rider') });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  return query;
}

export function useBooking(bookingId: string | undefined) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.booking(bookingId ?? 'none'),
    queryFn: () => fetchBooking(bookingId as string),
    enabled: !!bookingId,
  });

  React.useEffect(() => {
    if (!bookingId) return;

    const channel = supabase
      .channel(`booking-${bookingId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings', filter: `id=eq.${bookingId}` },
        () => void queryClient.invalidateQueries({ queryKey: qk.booking(bookingId) }),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [bookingId, queryClient]);

  return query;
}

export function useBookingEvents(bookingId: string | undefined) {
  return useQuery({
    queryKey: qk.bookingEvents(bookingId ?? 'none'),
    queryFn: () => fetchBookingEvents(bookingId as string),
    enabled: !!bookingId,
  });
}

/** Offer ledger, so the customer can see how many riders have been contacted. */
export function useBookingDispatches(bookingId: string | undefined, live: boolean) {
  return useQuery({
    queryKey: ['booking', bookingId, 'dispatches'],
    queryFn: () => fetchBookingDispatches(bookingId as string),
    enabled: !!bookingId,
    refetchInterval: live ? 4_000 : false,
  });
}

export function useBookingHistory(role: 'customer' | 'rider') {
  const { user } = useAuth();
  return useQuery({
    queryKey: qk.bookingHistory(role),
    queryFn: () =>
      fetchBookingHistory(role === 'customer' ? 'customer_id' : 'rider_id', user?.id as string),
    enabled: !!user?.id,
  });
}

/**
 * The rider's live position for a booking the caller is allowed to watch.
 *
 * RLS decides whether this returns anything: a customer may only read the
 * rider assigned to their own live booking (migration 0005). The same policy
 * is applied to the Realtime stream, so there is no way to widen this from the
 * client.
 */
export function useRiderLiveLocation(riderId: string | null | undefined, enabled: boolean) {
  const [location, setLocation] = React.useState<RiderLocation | null>(null);

  React.useEffect(() => {
    if (!riderId || !enabled) {
      setLocation(null);
      return;
    }

    let active = true;

    // Seed with the current value, then stream updates.
    void supabase
      .from('rider_locations')
      .select('*')
      .eq('rider_id', riderId)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setLocation(data as RiderLocation);
      });

    const channel = supabase
      .channel(`rider-location-${riderId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rider_locations',
          filter: `rider_id=eq.${riderId}`,
        },
        (payload) => {
          if (!active) return;
          const next = payload.new as RiderLocation | Record<string, never>;
          if (next && 'rider_id' in next) setLocation(next as RiderLocation);
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [riderId, enabled]);

  return location;
}

// --- Mutations ---------------------------------------------------------------

export function useCreateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBookingInput) => createBooking(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.activeBooking() });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, reason }: { bookingId: string; reason?: string }) =>
      cancelBooking(bookingId, reason),
    onSuccess: () => {
      toast.success('Ride cancelled');
      void queryClient.invalidateQueries({ queryKey: qk.activeBooking() });
      void queryClient.invalidateQueries({ queryKey: ['booking', 'rider-active'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRetryDispatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bookingId: string) => retryDispatch(bookingId),
    onSuccess: () => {
      toast.success('Searching again');
      void queryClient.invalidateQueries({ queryKey: qk.activeBooking() });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, to }: { bookingId: string; to: BookingStatus }) =>
      advanceStatus(bookingId, to),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['booking', 'rider-active'] });
      void queryClient.invalidateQueries({ queryKey: qk.riderStats() });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Convenience: is this booking still in a state the UI should treat as live? */
export function isLive(booking: BookingWithParties | null | undefined): boolean {
  if (!booking) return false;
  return (
    booking.status === 'searching' ||
    booking.status === 'assigned' ||
    booking.status === 'rider_arriving' ||
    booking.status === 'arrived' ||
    booking.status === 'in_progress'
  );
}
