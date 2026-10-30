import { formatDistanceToNow } from 'date-fns';
import { Car, CircleDollarSign, Star, TrendingUp } from 'lucide-react';
import { AppShell } from '@/components/shared/AppShell';
import { BookingListItem } from '@/components/shared/BookingListItem';
import { DispatchStatusBadge } from '@/components/shared/StatusBadge';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonList } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDistance, formatMoney } from '@/lib/utils';
import { useBookingHistory } from '@/features/booking/hooks';
import { useRecentOffers, useRiderStats } from '@/features/dispatch/hooks';

export default function RiderHistory() {
  const { data: rides, isLoading, isError, error, refetch } = useBookingHistory('rider');
  const { data: offers } = useRecentOffers();
  const { data: stats } = useRiderStats();

  return (
    <AppShell title="Your rides">
      <div className="mx-auto max-w-lg space-y-4 p-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <Metric icon={Car} label="Total rides" value={String(stats?.rides_total ?? 0)} />
            <Metric
              icon={CircleDollarSign}
              label="Total earned"
              value={formatMoney(stats?.earnings_total ?? 0)}
            />
            <Metric
              icon={Star}
              label="Rating"
              value={stats?.rating != null ? Number(stats.rating).toFixed(1) : '--'}
            />
            <Metric
              icon={TrendingUp}
              label="Acceptance"
              value={stats?.acceptance_rate != null ? `${stats.acceptance_rate}%` : '--'}
            />
          </CardContent>
        </Card>

        <Tabs defaultValue="rides">
          <TabsList className="w-full">
            <TabsTrigger value="rides" className="flex-1">
              Completed rides
            </TabsTrigger>
            <TabsTrigger value="requests" className="flex-1">
              Requests
            </TabsTrigger>
          </TabsList>

          <TabsContent value="rides" className="space-y-3">
            {isLoading && <SkeletonList rows={3} />}
            {isError && (
              <ErrorState description={(error as Error)?.message} onRetry={() => void refetch()} />
            )}
            {!isLoading && !isError && !rides?.length && (
              <EmptyState
                icon={Car}
                title="No rides yet"
                description="Go online to start receiving requests."
              />
            )}
            {rides?.map((booking) => (
              <BookingListItem
                key={booking.id}
                booking={booking}
                to={`/trip/${booking.id}`}
                counterparty="customer"
              />
            ))}
          </TabsContent>

          {/* The offer ledger: a rider can see exactly what they were sent. */}
          <TabsContent value="requests">
            {!offers?.length ? (
              <EmptyState
                title="No requests yet"
                description="Requests you accept, decline or miss are listed here."
              />
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {offers.map((offer) => (
                  <li key={offer.id} className="flex items-center gap-3 p-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        Request #{offer.sequence}
                        {offer.distance_m != null && (
                          <span className="font-normal text-muted-foreground">
                            {' '}
                            · {formatDistance(offer.distance_m)} away
                          </span>
                        )}
                      </p>
                      <time className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(offer.offered_at), { addSuffix: true })}
                      </time>
                    </div>
                    <DispatchStatusBadge status={offer.status} />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Car;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-secondary p-3">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="tabular truncate text-sm font-bold">{value}</p>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
