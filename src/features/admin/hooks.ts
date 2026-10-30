import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { qk } from '@/lib/query';
import type { BookingStatus } from '@/types/database';
import {
  assignRider,
  fetchAdminBookings,
  fetchAdminStats,
  fetchAllRiders,
  fetchAssignableRiders,
  fetchCustomers,
  fetchFleet,
  setRiderActive,
  setSetting,
  upsertRiderDetails,
  type RiderDetailsInput,
} from './api';

export function useAdminStats() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.adminStats(),
    queryFn: fetchAdminStats,
    refetchInterval: 20_000,
  });

  // Keep the counters honest while an operator watches the screen.
  React.useEffect(() => {
    const channel = supabase
      .channel('admin-stats')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () =>
        queryClient.invalidateQueries({ queryKey: qk.adminStats() }),
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'riders' }, () =>
        queryClient.invalidateQueries({ queryKey: qk.adminStats() }),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return query;
}

export function useAdminRiders() {
  return useQuery({ queryKey: qk.adminRiders(), queryFn: fetchAllRiders, refetchInterval: 30_000 });
}

export function useAssignableRiders(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'riders', 'assignable'],
    queryFn: fetchAssignableRiders,
    enabled,
  });
}

/** Live fleet positions. Admins may read every rider_locations row (RLS 0005). */
export function useFleet() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.adminFleet(),
    queryFn: fetchFleet,
    refetchInterval: 15_000,
  });

  React.useEffect(() => {
    const channel = supabase
      .channel('admin-fleet')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rider_locations' }, () =>
        queryClient.invalidateQueries({ queryKey: qk.adminFleet() }),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return query;
}

export function useAdminBookings(status: BookingStatus | 'all' | 'active', search: string) {
  return useQuery({
    queryKey: qk.adminBookings(status, search),
    queryFn: () => fetchAdminBookings(status, search),
    refetchInterval: status === 'active' ? 10_000 : false,
  });
}

export function useAdminCustomers(search: string) {
  return useQuery({
    queryKey: qk.adminCustomers(search),
    queryFn: () => fetchCustomers(search),
  });
}

function useAdminInvalidate() {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['admin'] });
  }, [queryClient]);
}

export function useAssignRider() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: ({ bookingId, riderId }: { bookingId: string; riderId: string }) =>
      assignRider(bookingId, riderId),
    onSuccess: () => {
      toast.success('Rider assigned');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSetRiderActive() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: ({ riderId, active }: { riderId: string; active: boolean }) =>
      setRiderActive(riderId, active),
    onSuccess: (active) => {
      toast.success(active ? 'Rider activated' : 'Rider deactivated');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpsertRiderDetails() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: RiderDetailsInput) => upsertRiderDetails(input),
    onSuccess: () => {
      toast.success('Rider saved');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => setSetting(key, value),
    onSuccess: () => {
      toast.success('Setting updated');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings', 'all'] });
      void queryClient.invalidateQueries({ queryKey: qk.settings() });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
