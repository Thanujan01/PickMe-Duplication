import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { ChevronRight } from 'lucide-react';
import { BookingStatusBadge } from './StatusBadge';
import { formatDistance, formatDuration, formatMoney } from '@/lib/utils';
import type { BookingWithParties } from '@/types/database';

export function BookingListItem({
  booking,
  to,
  counterparty,
}: {
  booking: BookingWithParties;
  to: string;
  /** Which side's name to show, from the viewer's perspective. */
  counterparty?: 'rider' | 'customer' | 'none';
}) {
  const name =
    counterparty === 'rider'
      ? booking.rider?.profile?.full_name
      : counterparty === 'customer'
        ? booking.customer?.full_name
        : null;

  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-card transition hover:bg-secondary/40"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <BookingStatusBadge status={booking.status} />
          <time className="text-xs text-muted-foreground">
            {format(new Date(booking.created_at), 'd MMM, HH:mm')}
          </time>
        </div>

        <div className="mt-2.5 space-y-1.5">
          <div className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
            <p className="min-w-0 flex-1 truncate text-sm">
              {booking.pickup_address || 'Pickup point'}
            </p>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
            <p className="min-w-0 flex-1 truncate text-sm">
              {booking.destination_address || 'Destination'}
            </p>
          </div>
        </div>

        <div className="mt-2.5 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular">{formatDistance(booking.estimated_distance)}</span>
          <span className="tabular">{formatDuration(booking.estimated_duration)}</span>
          {booking.status === 'completed' && (
            <span className="tabular font-semibold text-foreground">
              {formatMoney(booking.estimated_fare == null ? null : Number(booking.estimated_fare))}
            </span>
          )}
          {name && <span className="ml-auto truncate">{name}</span>}
        </div>
      </div>

      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
