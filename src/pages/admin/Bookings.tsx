import * as React from 'react';
import { format } from 'date-fns';
import { Clock, Search, UserPlus, XCircle } from 'lucide-react';
import { AppShell } from '@/components/shared/AppShell';
import { BookingStatusBadge } from '@/components/shared/StatusBadge';
import { EmptyState } from '@/components/shared/states';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SkeletonList } from '@/components/ui/skeleton';
import { formatDistance, formatDuration } from '@/lib/utils';
import { useAdminBookings, useAssignRider, useAssignableRiders } from '@/features/admin/hooks';
import { useCancelBooking } from '@/features/booking/hooks';
import type { BookingStatus, BookingWithParties } from '@/types/database';

const FILTERS: { value: BookingStatus | 'all' | 'active'; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'searching', label: 'Searching' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_rider_available', label: 'Unfulfilled' },
];

export default function AdminBookings() {
  const [filter, setFilter] = React.useState<BookingStatus | 'all' | 'active'>('active');
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [assigning, setAssigning] = React.useState<BookingWithParties | null>(null);

  const { data, isLoading } = useAdminBookings(filter, search);
  const cancel = useCancelBooking();

  // Debounce so typing does not hammer the database.
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  return (
    <AppShell title="Bookings">
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search address or booking id"
              className="pl-9"
            />
          </div>
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="w-40 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading && <SkeletonList rows={4} />}

        {!isLoading && !data?.length && (
          <EmptyState
            icon={Clock}
            title="No bookings found"
            description="Adjust the filter or search term."
          />
        )}

        {data?.map((booking) => {
          const cancellable = !['completed', 'cancelled', 'no_rider_available'].includes(
            booking.status,
          );
          const assignable = booking.status === 'searching' || booking.status === 'no_rider_available';

          return (
            <div key={booking.id} className="rounded-xl border border-border bg-card p-4 shadow-card">
              <div className="flex flex-wrap items-center gap-2">
                <BookingStatusBadge status={booking.status} />
                <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                  {booking.id.slice(0, 8)}
                </code>
                <time className="text-xs text-muted-foreground">
                  {format(new Date(booking.created_at), 'd MMM HH:mm')}
                </time>
                {booking.dispatch_round > 0 && booking.status === 'searching' && (
                  <Badge variant="warning">{booking.dispatch_round} contacted</Badge>
                )}
              </div>

              <div className="mt-3 space-y-1.5">
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                  <p className="min-w-0 flex-1 text-sm">{booking.pickup_address || '--'}</p>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                  <p className="min-w-0 flex-1 text-sm">{booking.destination_address || '--'}</p>
                </div>
              </div>

              <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
                <Pair label="Customer" value={booking.customer?.full_name || '--'} />
                <Pair label="Rider" value={booking.rider?.profile?.full_name || 'Unassigned'} />
                <Pair
                  label="Trip"
                  value={`${formatDistance(booking.estimated_distance)} · ${formatDuration(
                    booking.estimated_duration,
                  )}`}
                />
              </dl>

              {(assignable || cancellable) && (
                <div className="mt-3 flex gap-2">
                  {assignable && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => setAssigning(booking)}
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Assign rider
                    </Button>
                  )}
                  {cancellable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1 text-destructive hover:bg-destructive/10"
                      loading={cancel.isPending}
                      onClick={() =>
                        cancel.mutate({ bookingId: booking.id, reason: 'cancelled_by_support' })
                      }
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Cancel
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <AssignDialog booking={assigning} onClose={() => setAssigning(null)} />
    </AppShell>
  );
}

function AssignDialog({
  booking,
  onClose,
}: {
  booking: BookingWithParties | null;
  onClose: () => void;
}) {
  const { data: riders, isLoading } = useAssignableRiders(!!booking);
  const assign = useAssignRider();
  const [selected, setSelected] = React.useState<string>('');

  React.useEffect(() => {
    setSelected('');
  }, [booking?.id]);

  return (
    <Dialog open={!!booking} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign a rider manually</DialogTitle>
          <DialogDescription>
            This bypasses the sequential dispatch and assigns immediately. Use it when nobody
            accepted automatically.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <SkeletonList rows={2} />
        ) : !riders?.length ? (
          <p className="rounded-lg bg-secondary px-3 py-2.5 text-sm text-muted-foreground">
            No active riders are free right now.
          </p>
        ) : (
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a rider" />
            </SelectTrigger>
            <SelectContent>
              {riders.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.profile?.full_name || r.id.slice(0, 8)} · {r.availability}
                  {r.vehicles[0] ? ` · ${r.vehicles[0].plate_number}` : ' · no vehicle'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected}
            loading={assign.isPending}
            onClick={async () => {
              if (!booking || !selected) return;
              await assign.mutateAsync({ bookingId: booking.id, riderId: selected });
              onClose();
            }}
          >
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
