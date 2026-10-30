import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { qk } from '@/lib/query';
import { secondsUntil } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthProvider';
import { setAvailability } from '@/features/gps/api';
import type { RiderAvailability } from '@/types/database';
import {
  acceptBooking,
  fetchCurrentOffer,
  fetchMyRider,
  fetchMyVehicles,
  fetchRecentOffers,
  fetchRiderStats,
  rejectBooking,
} from './api';

export function useMyRider() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;

  const query = useQuery({
    queryKey: qk.riderMe(),
    queryFn: () => fetchMyRider(userId as string),
    enabled: !!userId,
  });

  // availability is changed by the dispatcher too (busy on accept, online on
  // complete), so mirror it in realtime rather than trusting local state.
  React.useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`rider-self-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'riders', filter: `id=eq.${userId}` },
        () => void queryClient.invalidateQueries({ queryKey: qk.riderMe() }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  return query;
}

export function useMyVehicles() {
  const { user } = useAuth();
  return useQuery({
    queryKey: qk.riderVehicles(user?.id ?? 'none'),
    queryFn: () => fetchMyVehicles(user?.id as string),
    enabled: !!user?.id,
  });
}

export function useRiderStats() {
  const { user } = useAuth();
  return useQuery({
    queryKey: qk.riderStats(),
    queryFn: fetchRiderStats,
    enabled: !!user?.id,
  });
}

export function useRecentOffers() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['rider', 'recent-offers'],
    queryFn: () => fetchRecentOffers(user?.id as string),
    enabled: !!user?.id,
  });
}

/**
 * The rider's open offer, kept live by Realtime on `booking_dispatches`.
 *
 * A short poll runs alongside the subscription because the offer *expires* on
 * the server with no row change at that instant - the row only flips to
 * 'timeout' when the next dispatch tick reaps it, which may be a few seconds
 * later. Polling keeps the card from lingering past its deadline.
 */
export function useCurrentOffer(enabled: boolean) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;

  const query = useQuery({
    queryKey: qk.riderOffer(),
    queryFn: () => fetchCurrentOffer(userId as string),
    enabled: !!userId && enabled,
    refetchInterval: enabled ? 3_000 : false,
    staleTime: 0,
  });

  React.useEffect(() => {
    if (!userId || !enabled) return;

    const channel = supabase
      .channel(`rider-offers-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'booking_dispatches',
          filter: `rider_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: qk.riderOffer() });
          void queryClient.invalidateQueries({ queryKey: ['rider', 'recent-offers'] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, enabled, queryClient]);

  // Drop the card the moment the server deadline passes.
  const expiresAt = query.data?.dispatch.expires_at;
  React.useEffect(() => {
    if (!expiresAt) return;
    const ms = secondsUntil(expiresAt) * 1000;
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: qk.riderOffer() });
    }, ms + 250);
    return () => clearTimeout(timer);
  }, [expiresAt, queryClient]);

  return query;
}

/** Second-resolution countdown against a server timestamp. Display only. */
export function useCountdown(expiresAt: string | null | undefined): number {
  const [remaining, setRemaining] = React.useState(() => secondsUntil(expiresAt));

  React.useEffect(() => {
    setRemaining(secondsUntil(expiresAt));
    if (!expiresAt) return;
    const timer = setInterval(() => setRemaining(secondsUntil(expiresAt)), 250);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return remaining;
}

export function useAcceptOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bookingId: string) => acceptBooking(bookingId),
    onSuccess: () => {
      toast.success('Ride accepted');
      void queryClient.invalidateQueries({ queryKey: qk.riderOffer() });
      void queryClient.invalidateQueries({ queryKey: ['booking', 'rider-active'] });
      void queryClient.invalidateQueries({ queryKey: qk.riderMe() });
    },
    onError: (e: Error) => {
      // 'booking_taken' and 'offer_expired' are normal outcomes of a race, not
      // faults - say so plainly and clear the card.
      toast.error(e.message);
      void queryClient.invalidateQueries({ queryKey: qk.riderOffer() });
    },
  });
}

export function useRejectOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bookingId: string) => rejectBooking(bookingId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.riderOffer() });
      void queryClient.invalidateQueries({ queryKey: ['rider', 'recent-offers'] });
    },
    onError: (e: Error) => {
      toast.error(e.message);
      void queryClient.invalidateQueries({ queryKey: qk.riderOffer() });
    },
  });
}

export function useSetAvailability() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: RiderAvailability) => setAvailability(status),
    onSuccess: (status) => {
      toast.success(status === 'online' ? "You're online" : "You're offline");
      void queryClient.invalidateQueries({ queryKey: qk.riderMe() });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
