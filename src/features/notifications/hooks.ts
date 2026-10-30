import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase, toAppError, unwrap } from '@/lib/supabase';
import { qk } from '@/lib/query';
import { useAuth } from '@/features/auth/AuthProvider';
import type { AppNotification } from '@/types/database';
import { alertRider, showLocalNotification } from './push';

async function fetchNotifications(limit = 30): Promise<AppNotification[]> {
  return unwrap(
    await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit),
  ) as AppNotification[];
}

async function markRead(ids?: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('mark_notifications_read', { p_ids: ids ?? null });
  if (error) throw toAppError(error);
  return data as number;
}

/**
 * In-app inbox plus live delivery.
 *
 * Every notification inserted by the dispatch functions arrives here over
 * Realtime and is surfaced three ways: a toast, a browser notification (when
 * permitted), and the unread badge. A ride request also buzzes the device.
 */
export function useNotifications() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;

  const query = useQuery({
    queryKey: qk.notifications(),
    queryFn: () => fetchNotifications(),
    enabled: !!userId,
  });

  React.useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`notifications-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (payload) => {
          const n = payload.new as AppNotification;
          void queryClient.invalidateQueries({ queryKey: qk.notifications() });

          if (n.type === 'ride_request') {
            alertRider();
            void showLocalNotification({
              title: n.title,
              body: n.body,
              tag: `ride-request-${n.booking_id ?? n.id}`,
              url: '/rider',
              requireInteraction: true,
            });
            // The offer card itself is the primary affordance; no toast, which
            // would compete with it for attention.
            return;
          }

          const kind =
            n.type === 'booking_cancelled' || n.type === 'no_rider_available' ? 'error' : 'success';
          toast[kind](n.title, { description: n.body || undefined });

          void showLocalNotification({
            title: n.title,
            body: n.body,
            tag: n.booking_id ? `booking-${n.booking_id}` : n.id,
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  const unread = React.useMemo(
    () => (query.data ?? []).filter((n) => !n.read_at).length,
    [query.data],
  );

  return { ...query, unread };
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => markRead(ids),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.notifications() }),
  });
}
