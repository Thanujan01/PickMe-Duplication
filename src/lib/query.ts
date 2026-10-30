import { QueryClient } from '@tanstack/react-query';

/**
 * Realtime pushes most invalidations, so default polling is off and staleness
 * is generous. Anything that genuinely needs an interval sets its own.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error) => {
        const code = (error as { code?: string } | null)?.code;
        // Never retry a decision the server has already made.
        const terminal = [
          'not_authenticated',
          'not_authorized',
          'booking_taken',
          'offer_expired',
          'offer_not_pending',
          'no_offer_for_rider',
          'active_booking_exists',
          'illegal_transition',
        ];
        if (code && terminal.includes(code)) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: 0 },
  },
});

export const qk = {
  profile: (id: string) => ['profile', id] as const,
  settings: () => ['admin-settings'] as const,

  activeBooking: () => ['booking', 'active'] as const,
  booking: (id: string) => ['booking', id] as const,
  bookingEvents: (id: string) => ['booking', id, 'events'] as const,
  bookingHistory: (role: string) => ['bookings', 'history', role] as const,

  riderMe: () => ['rider', 'me'] as const,
  riderStats: () => ['rider', 'stats'] as const,
  riderOffer: () => ['rider', 'offer'] as const,
  riderVehicles: (id: string) => ['rider', id, 'vehicles'] as const,
  riderLocation: (id: string) => ['rider', id, 'location'] as const,

  notifications: () => ['notifications'] as const,

  adminStats: () => ['admin', 'stats'] as const,
  adminRiders: () => ['admin', 'riders'] as const,
  adminBookings: (filter: string, search: string) => ['admin', 'bookings', filter, search] as const,
  adminFleet: () => ['admin', 'fleet'] as const,
  adminCustomers: (search: string) => ['admin', 'customers', search] as const,
} as const;
