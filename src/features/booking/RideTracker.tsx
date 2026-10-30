import * as React from 'react';
import {
  CheckCircle2,
  Clock,
  Loader2,
  Phone,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  XCircle,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
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
import { formatDistance, formatDuration, formatMoney, initials, secondsUntil } from '@/lib/utils';
import type { BookingWithParties } from '@/types/database';
import { useBookingDispatches, useCancelBooking, useRetryDispatch } from './hooks';
import type { TrackingLayers } from './useTrackingLayers';

/**
 * The live-ride panel. Four distinct states, each with its own affordances:
 * searching, no rider found, rider en route, and trip under way.
 */
export function RideTracker({
  booking,
  layers,
}: {
  booking: BookingWithParties;
  layers: TrackingLayers;
}) {
  const cancel = useCancelBooking();
  const retry = useRetryDispatch();
  const [confirmCancel, setConfirmCancel] = React.useState(false);

  const searching = booking.status === 'searching';
  const { data: dispatches } = useBookingDispatches(booking.id, searching);

  const riderProfile = booking.rider?.profile;
  const vehicle = booking.rider?.vehicles?.find((v) => v.is_primary) ?? booking.rider?.vehicles?.[0];

  const contacted = dispatches?.length ?? booking.dispatch_round;
  const searchRemaining = secondsUntil(booking.search_expires_at);

  return (
    <>
      <div className="absolute inset-x-0 bottom-0 z-30 p-3 pb-20">
        <div className="animate-slide-up rounded-2xl border border-border bg-card shadow-sheet">
          {/* ---------------- Searching ---------------- */}
          {searching && (
            <div className="p-5">
              <div className="flex items-center gap-3">
                <div className="relative flex h-11 w-11 items-center justify-center">
                  <span className="marker-pulse absolute inset-0 rounded-full" />
                  <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-accent/15">
                    <Search className="h-5 w-5 text-accent" />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">Finding your rider</p>
                  <p className="text-sm text-muted-foreground">
                    {contacted > 0
                      ? `Contacted ${contacted} rider${contacted === 1 ? '' : 's'} so far`
                      : 'Contacting the nearest rider'}
                  </p>
                </div>
                {searchRemaining > 0 && (
                  <span className="tabular shrink-0 text-sm text-muted-foreground">
                    {formatDuration(searchRemaining)}
                  </span>
                )}
              </div>

              {/* Offer ledger: shows the sequential dispatch in motion. */}
              {!!dispatches?.length && (
                <div className="mt-4 flex items-center gap-1.5">
                  {dispatches.map((d) => (
                    <span
                      key={d.id}
                      title={`Rider ${d.sequence}: ${d.status}`}
                      className={
                        d.status === 'pending'
                          ? 'h-1.5 flex-1 animate-pulse rounded-full bg-accent'
                          : d.status === 'accepted'
                            ? 'h-1.5 flex-1 rounded-full bg-success'
                            : 'h-1.5 flex-1 rounded-full bg-muted'
                      }
                    />
                  ))}
                </div>
              )}

              <Separator className="my-4" />
              <TripSummary booking={booking} />

              <Button
                variant="outline"
                className="mt-4 w-full"
                onClick={() => setConfirmCancel(true)}
                loading={cancel.isPending}
              >
                Cancel request
              </Button>
            </div>
          )}

          {/* ---------------- Nobody accepted ---------------- */}
          {booking.status === 'no_rider_available' && (
            <div className="p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
                  <XCircle className="h-5 w-5 text-destructive" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">No riders available</p>
                  <p className="text-sm text-muted-foreground">
                    We contacted {contacted} rider{contacted === 1 ? '' : 's'} with no luck.
                  </p>
                </div>
              </div>

              <Separator className="my-4" />
              <TripSummary booking={booking} />

              <div className="mt-4 flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => cancel.mutate({ bookingId: booking.id })}
                  loading={cancel.isPending}
                >
                  Close
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => retry.mutate(booking.id)}
                  loading={retry.isPending}
                >
                  <RefreshCw className="h-4 w-4" />
                  Try again
                </Button>
              </div>
            </div>
          )}

          {/* ---------------- Rider assigned / en route / arrived / driving ---------------- */}
          {(booking.status === 'assigned' ||
            booking.status === 'rider_arriving' ||
            booking.status === 'arrived' ||
            booking.status === 'in_progress') && (
            <div className="p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <BookingStatusBadge status={booking.status} />
                {booking.status === 'in_progress' ? (
                  <span className="tabular text-sm text-muted-foreground">
                    {formatDistance(layers.remainingDistance)} to go
                  </span>
                ) : (
                  <span className="tabular text-sm text-muted-foreground">
                    {layers.etaSeconds != null
                      ? `${formatDuration(layers.etaSeconds)} away`
                      : layers.remainingDistance != null
                        ? `${formatDistance(layers.remainingDistance)} away`
                        : 'Locating rider…'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12">
                  {riderProfile?.avatar_url && <AvatarImage src={riderProfile.avatar_url} alt="" />}
                  <AvatarFallback>{initials(riderProfile?.full_name)}</AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{riderProfile?.full_name || 'Your rider'}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {booking.rider?.rating != null && (
                      <span className="flex items-center gap-1">
                        <Star className="h-3 w-3 fill-warning text-warning" />
                        <span className="tabular">{Number(booking.rider.rating).toFixed(1)}</span>
                      </span>
                    )}
                    {booking.rider?.total_rides != null && (
                      <span className="tabular">{booking.rider.total_rides} rides</span>
                    )}
                  </div>
                </div>

                {riderProfile?.phone && (
                  <Button variant="accent" size="icon" asChild aria-label="Call rider">
                    <a href={`tel:${riderProfile.phone}`}>
                      <Phone className="h-5 w-5" />
                    </a>
                  </Button>
                )}
              </div>

              {vehicle && (
                <div className="mt-3 flex items-center justify-between rounded-xl bg-secondary px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {[vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(' ') ||
                        vehicle.vehicle_type}
                    </p>
                    <p className="text-xs capitalize text-muted-foreground">{vehicle.vehicle_type}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 font-mono tracking-wider">
                    {vehicle.plate_number}
                  </Badge>
                </div>
              )}

              {booking.status === 'arrived' && (
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2.5 text-sm text-success">
                  <ShieldCheck className="h-4 w-4 shrink-0" />
                  Your rider is waiting at the pickup point.
                </div>
              )}

              <Separator className="my-3" />
              <TripSummary booking={booking} />

              {booking.status !== 'in_progress' && (
                <Button
                  variant="ghost"
                  className="mt-3 w-full text-destructive hover:bg-destructive/10"
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel ride
                </Button>
              )}
            </div>
          )}

          {/* ---------------- Terminal states (brief, before the query clears) ---------------- */}
          {(booking.status === 'completed' || booking.status === 'cancelled') && (
            <div className="flex items-center gap-3 p-5">
              {booking.status === 'completed' ? (
                <CheckCircle2 className="h-6 w-6 text-success" />
              ) : (
                <XCircle className="h-6 w-6 text-destructive" />
              )}
              <p className="font-semibold">
                {booking.status === 'completed' ? 'Trip completed' : 'Ride cancelled'}
              </p>
              <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      </div>

      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this ride?</DialogTitle>
            <DialogDescription>
              {booking.status === 'searching'
                ? 'We will stop contacting riders.'
                : 'Your rider is already on the way. Frequent cancellations may affect your account.'}
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
                cancel.mutate({ bookingId: booking.id, reason: 'customer_cancelled' });
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

function TripSummary({ booking }: { booking: BookingWithParties }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-success" />
        <p className="min-w-0 flex-1 truncate text-sm">{booking.pickup_address || 'Pickup point'}</p>
      </div>
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-foreground" />
        <p className="min-w-0 flex-1 truncate text-sm">
          {booking.destination_address || 'Destination'}
        </p>
      </div>
      <div className="flex items-center gap-4 pt-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          <span className="tabular">{formatDuration(booking.estimated_duration)}</span>
        </span>
        <span className="tabular">{formatDistance(booking.estimated_distance)}</span>
        <span className="tabular ml-auto font-semibold text-foreground">
          {formatMoney(booking.estimated_fare == null ? null : Number(booking.estimated_fare))}
        </span>
      </div>
    </div>
  );
}
