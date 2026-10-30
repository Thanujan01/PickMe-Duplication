import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { BookingStatus, DispatchStatus, RiderAvailability } from '@/types/database';

const BOOKING_LABELS: Record<BookingStatus, { label: string; variant: BadgeProps['variant'] }> = {
  searching: { label: 'Finding a rider', variant: 'warning' },
  assigned: { label: 'Rider assigned', variant: 'default' },
  rider_arriving: { label: 'On the way', variant: 'default' },
  arrived: { label: 'Rider arrived', variant: 'success' },
  in_progress: { label: 'In progress', variant: 'success' },
  completed: { label: 'Completed', variant: 'secondary' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
  no_rider_available: { label: 'No rider found', variant: 'destructive' },
};

export function BookingStatusBadge({ status, className }: { status: BookingStatus; className?: string }) {
  const { label, variant } = BOOKING_LABELS[status];
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}

export function bookingStatusLabel(status: BookingStatus): string {
  return BOOKING_LABELS[status].label;
}

const AVAILABILITY_LABELS: Record<RiderAvailability, { label: string; variant: BadgeProps['variant'] }> = {
  online: { label: 'Online', variant: 'success' },
  offline: { label: 'Offline', variant: 'secondary' },
  busy: { label: 'On a ride', variant: 'warning' },
};

export function AvailabilityBadge({
  availability,
  stale,
  className,
}: {
  availability: RiderAvailability;
  stale?: boolean;
  className?: string;
}) {
  if (stale && availability === 'online') {
    return (
      <Badge variant="warning" className={className}>
        GPS stale
      </Badge>
    );
  }
  const { label, variant } = AVAILABILITY_LABELS[availability];
  return (
    <Badge variant={variant} className={className}>
      <span
        className={
          availability === 'online'
            ? 'h-1.5 w-1.5 rounded-full bg-success'
            : availability === 'busy'
              ? 'h-1.5 w-1.5 rounded-full bg-warning'
              : 'h-1.5 w-1.5 rounded-full bg-muted-foreground'
        }
      />
      {label}
    </Badge>
  );
}

const DISPATCH_LABELS: Record<DispatchStatus, { label: string; variant: BadgeProps['variant'] }> = {
  pending: { label: 'Awaiting response', variant: 'warning' },
  accepted: { label: 'Accepted', variant: 'success' },
  rejected: { label: 'Declined', variant: 'destructive' },
  timeout: { label: 'No response', variant: 'secondary' },
  cancelled: { label: 'Withdrawn', variant: 'secondary' },
};

export function DispatchStatusBadge({ status }: { status: DispatchStatus }) {
  const { label, variant } = DISPATCH_LABELS[status];
  return <Badge variant={variant}>{label}</Badge>;
}
