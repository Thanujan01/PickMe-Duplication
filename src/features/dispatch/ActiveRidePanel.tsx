import * as React from 'react';
import {
  CheckCircle2,
  Flag,
  MapPin,
  Navigation,
  Phone,
  UserRound,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { BookingStatusBadge } from '@/components/shared/StatusBadge';
import { formatDistance, formatDuration, formatMoney, initials } from '@/lib/utils';
import type { LatLng } from '@/lib/geo';
import { navigationUrl } from '@/features/map/routing';
import { useAdvanceStatus, useCancelBooking } from '@/features/booking/hooks';
import type { BookingStatus, BookingWithParties } from '@/types/database';

/**
 * The rider's in-ride controls (spec section 6).
 *
 * Each button performs exactly one legal transition; the state machine in
 * advance_booking_status() rejects anything out of order, so the UI cannot
 * drive the booking into an invalid state even if it is stale.
 */
const NEXT_STEP: Partial<
  Record<BookingStatus, { to: BookingStatus; label: string; icon: typeof Flag; variant: 'default' | 'accent' }>
> = {
  assigned: { to: 'rider_arriving', label: 'Start heading to pickup', icon: Navigation, variant: 'default' },
  rider_arriving: { to: 'arrived', label: "I've arrived", icon: MapPin, variant: 'default' },
  arrived: { to: 'in_progress', label: 'Start trip', icon: Flag, variant: 'accent' },
  in_progress: { to: 'completed', label: 'Complete trip', icon: CheckCircle2, variant: 'accent' },
};

export function ActiveRidePanel({
  booking,
  riderPosition,
  remainingDistance,
  etaSeconds,
}: {
  booking: BookingWithParties;
  riderPosition: LatLng | null;
  remainingDistance: number | null;
  etaSeconds: number | null;
}) {
  const advance = useAdvanceStatus();
  const cancel = useCancelBooking();
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [confirmComplete, setConfirmComplete] = React.useState(false);

  const step = NEXT_STEP[booking.status];
  const onTrip = booking.status === 'in_progress';

  const target: LatLng = onTrip
    ? { lat: booking.destination_latitude, lng: booking.destination_longitude }
    : { lat: booking.pickup_latitude, lng: booking.pickup_longitude };

  const customer = booking.customer;

  const runStep = () => {
    if (!step) return;
    // Completing is irreversible and ends the fare, so it gets a confirmation.
    if (step.to === 'completed') {
      setConfirmComplete(true);
      return;
    }
    advance.mutate({ bookingId: booking.id, to: step.to });
  };

  return (
    <>
      <div className="absolute inset-x-0 bottom-0 z-30 p-3 pb-20">
        <div className="animate-slide-up rounded-2xl border border-border bg-card shadow-sheet">
          <div className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <BookingStatusBadge status={booking.status} />
              <span className="tabular text-sm text-muted-foreground">
                {etaSeconds != null
                  ? `${formatDuration(etaSeconds)} · ${formatDistance(remainingDistance)}`
                  : formatDistance(remainingDistance)}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <Avatar className="h-11 w-11">
                {customer?.avatar_url && <AvatarImage src={customer.avatar_url} alt="" />}
                <AvatarFallback>
                  {customer?.full_name ? initials(customer.full_name) : <UserRound className="h-4 w-4" />}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{customer?.full_name || 'Customer'}</p>
                <p className="tabular text-xs text-muted-foreground">
                  {formatMoney(
                    booking.estimated_fare == null ? null : Number(booking.estimated_fare),
                  )}{' '}
                  · {formatDistance(booking.estimated_distance)}
                </p>
              </div>
              {customer?.phone && (
                <Button variant="accent" size="icon" asChild aria-label="Call customer">
                  <a href={`tel:${customer.phone}`}>
                    <Phone className="h-5 w-5" />
                  </a>
                </Button>
              )}
            </div>

            <Separator className="my-3" />

            <div className="space-y-2">
              <div className="flex items-start gap-2.5">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-success" />
                <p className="min-w-0 flex-1 text-sm">
                  {booking.pickup_address || 'Pickup point'}
                </p>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-foreground" />
                <p className="min-w-0 flex-1 text-sm">
                  {booking.destination_address || 'Destination'}
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {/* Hand-off to turn-by-turn navigation (spec section 6). */}
              <Button variant="outline" size="lg" className="w-full" asChild>
                <a
                  href={navigationUrl(target, riderPosition ?? undefined)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Navigation className="h-4 w-4" />
                  Navigate to {onTrip ? 'destination' : 'pickup'}
                </a>
              </Button>

              {step && (
                <Button
                  variant={step.variant}
                  size="lg"
                  className="w-full"
                  loading={advance.isPending}
                  onClick={runStep}
                >
                  <step.icon className="h-4 w-4" />
                  {step.label}
                </Button>
              )}

              {!onTrip && (
                <Button
                  variant="ghost"
                  className="w-full text-destructive hover:bg-destructive/10"
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel ride
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={confirmComplete} onOpenChange={setConfirmComplete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete this trip?</DialogTitle>
            <DialogDescription>
              Confirm you have dropped the customer at their destination. This closes the ride and
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmComplete(false)}>
              Not yet
            </Button>
            <Button
              variant="accent"
              loading={advance.isPending}
              onClick={() => {
                advance.mutate({ bookingId: booking.id, to: 'completed' });
                setConfirmComplete(false);
              }}
            >
              Complete trip
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this ride?</DialogTitle>
            <DialogDescription>
              The customer will be notified and will need to book again. Frequent cancellations
              affect your standing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCancel(false)}>
              Keep ride
            </Button>
            <Button
              variant="destructive"
              loading={cancel.isPending}
              onClick={() => {
                cancel.mutate({ bookingId: booking.id, reason: 'rider_cancelled' });
                setConfirmCancel(false);
              }}
            >
              Cancel ride
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
