import { MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/shared/AppShell';
import { BookingListItem } from '@/components/shared/BookingListItem';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { SkeletonList } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useBookingHistory } from '@/features/booking/hooks';

export default function CustomerHistory() {
  const { data, isLoading, isError, error, refetch } = useBookingHistory('customer');

  return (
    <AppShell title="Your trips">
      <div className="mx-auto max-w-lg space-y-3 p-4">
        {isLoading && <SkeletonList rows={4} />}

        {isError && (
          <ErrorState description={(error as Error)?.message} onRetry={() => void refetch()} />
        )}

        {!isLoading && !isError && !data?.length && (
          <EmptyState
            icon={MapPin}
            title="No trips yet"
            description="Your completed and cancelled rides will show up here."
            action={
              <Button asChild>
                <Link to="/">Book a ride</Link>
              </Button>
            }
          />
        )}

        {data?.map((booking) => (
          <BookingListItem
            key={booking.id}
            booking={booking}
            to={`/trip/${booking.id}`}
            counterparty="rider"
          />
        ))}
      </div>
    </AppShell>
  );
}
