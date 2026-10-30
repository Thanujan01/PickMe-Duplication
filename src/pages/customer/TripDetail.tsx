import { useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { AppShell } from '@/components/shared/AppShell';
import { BookingStatusBadge } from '@/components/shared/StatusBadge';
import { PlaceRow } from '@/components/shared/PlaceRow';
import { ErrorState } from '@/components/shared/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { MapCanvas } from '@/features/map/MapCanvas';
import { useBooking, useBookingEvents } from '@/features/booking/hooks';
import { formatDistance, formatDuration, formatMoney } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthProvider';

const EVENT_LABELS: Record<string, string> = {
  booking_created: 'Ride requested',
  dispatch_offered: 'Rider contacted',
  dispatch_rejected: 'Rider declined',
  dispatch_timeout: 'Rider did not respond',
  dispatch_retried: 'Search restarted',
  booking_accepted: 'Rider accepted',
  admin_assigned: 'Assigned by support',
  status_changed: 'Status changed',
  booking_cancelled: 'Ride cancelled',
  no_rider_available: 'No rider found',
};

/** Read-only receipt plus the full audit trail from booking_events. */
export default function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const { role } = useAuth();
  const { data: booking, isLoading, isError, error } = useBooking(id);
  const { data: events } = useBookingEvents(id);

  const back = role === 'rider' ? '/rider/history' : '/history';

  if (isLoading) {
    return (
      <AppShell title="Trip" back={back}>
        <div className="mx-auto max-w-lg space-y-3 p-4">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </AppShell>
    );
  }

  if (isError || !booking) {
    return (
      <AppShell title="Trip" back={back}>
        <ErrorState
          title="Trip not found"
          description={(error as Error)?.message ?? 'This trip may have been removed.'}
        />
      </AppShell>
    );
  }

  const pickup = { lat: booking.pickup_latitude, lng: booking.pickup_longitude };
  const destination = { lat: booking.destination_latitude, lng: booking.destination_longitude };
  const vehicle = booking.rider?.vehicles?.find((v) => v.is_primary) ?? booking.rider?.vehicles?.[0];

  return (
    <AppShell title="Trip details" back={back}>
      <div className="mx-auto max-w-lg space-y-3 p-4">
        <div className="h-48 overflow-hidden rounded-xl border border-border">
          <MapCanvas
            interactive={false}
            markers={[
              { id: 'pickup', position: pickup, kind: 'pickup' },
              { id: 'destination', position: destination, kind: 'destination' },
            ]}
            fit={[pickup, destination]}
          />
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>
              {format(new Date(booking.created_at), "d MMM yyyy 'at' HH:mm")}
            </CardTitle>
            <BookingStatusBadge status={booking.status} />
          </CardHeader>
          <CardContent>
            <PlaceRow kind="pickup" label="Pickup" value={booking.pickup_address} />
            <Separator className="my-1 ml-10 w-auto" />
            <PlaceRow kind="destination" label="Destination" value={booking.destination_address} />

            <Separator className="my-3" />

            <dl className="grid grid-cols-3 gap-2 text-center">
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Distance</dt>
                <dd className="tabular mt-0.5 text-sm font-semibold">
                  {formatDistance(booking.estimated_distance)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Duration</dt>
                <dd className="tabular mt-0.5 text-sm font-semibold">
                  {formatDuration(booking.estimated_duration)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Fare</dt>
                <dd className="tabular mt-0.5 text-sm font-semibold">
                  {formatMoney(booking.estimated_fare == null ? null : Number(booking.estimated_fare))}
                </dd>
              </div>
            </dl>

            {booking.cancellation_reason && (
              <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Cancelled: {booking.cancellation_reason.replace(/_/g, ' ')}
              </p>
            )}
          </CardContent>
        </Card>

        {(booking.rider?.profile || booking.customer) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {role === 'rider' ? 'Customer' : 'Rider'}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {role === 'rider'
                    ? booking.customer?.full_name || 'Customer'
                    : booking.rider?.profile?.full_name || 'Rider'}
                </p>
                {vehicle && role !== 'rider' && (
                  <p className="truncate text-xs text-muted-foreground">
                    {[vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(' ')}
                  </p>
                )}
              </div>
              {vehicle && role !== 'rider' && (
                <Badge variant="outline" className="shrink-0 font-mono tracking-wider">
                  {vehicle.plate_number}
                </Badge>
              )}
            </CardContent>
          </Card>
        )}

        {!!events?.length && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {events.map((e, i) => (
                  <li key={e.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className="mt-1.5 h-2 w-2 rounded-full bg-foreground" />
                      {i < events.length - 1 && <span className="my-1 w-px flex-1 bg-border" />}
                    </div>
                    <div className="min-w-0 flex-1 pb-1">
                      <p className="text-sm font-medium">
                        {EVENT_LABELS[e.event_type] ?? e.event_type.replace(/_/g, ' ')}
                        {e.to_status && e.event_type === 'status_changed' && (
                          <span className="font-normal text-muted-foreground">
                            {' '}
                            → {e.to_status.replace(/_/g, ' ')}
                          </span>
                        )}
                      </p>
                      <time className="tabular text-xs text-muted-foreground">
                        {format(new Date(e.created_at), 'HH:mm:ss')}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
