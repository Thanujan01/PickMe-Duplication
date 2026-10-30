import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Loader2, Satellite } from 'lucide-react';
import { AppShell } from '@/components/shared/AppShell';
import { AvailabilityBadge } from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { MapCanvas } from '@/features/map/MapCanvas';
import type { MapMarker, MarkerKind } from '@/features/map/types';
import { useFleet } from '@/features/admin/hooks';
import { usePublicSettings } from '@/features/settings/hooks';
import { isValidLatLng, type LatLng } from '@/lib/geo';
import { secondsSince } from '@/lib/utils';
import type { RiderWithProfile } from '@/types/database';

/**
 * Administrator-only live fleet map.
 *
 * This is the one place every rider's position is visible at once, and it is
 * gated by the admin branch of the rider_locations RLS policy - a customer
 * calling the same query gets at most their own assigned rider.
 */
export default function AdminFleet() {
  const { data: fleet, isLoading } = useFleet();
  const { data: settings } = usePublicSettings();
  const [selected, setSelected] = React.useState<RiderWithProfile | null>(null);

  const staleSeconds = settings?.gpsStaleSeconds ?? 45;

  const markers = React.useMemo<MapMarker[]>(() => {
    return (fleet ?? [])
      .filter((r) => r.location && isValidLatLng({ lat: r.location.latitude, lng: r.location.longitude }))
      .map((r) => {
        const stale = secondsSince(r.location?.last_seen) > staleSeconds;
        const kind: MarkerKind =
          stale ? 'fleet-stale' : r.availability === 'busy' ? 'fleet-busy' : 'fleet';

        return {
          id: r.id,
          position: { lat: r.location!.latitude, lng: r.location!.longitude },
          kind,
          heading: r.location?.heading ?? null,
          label: r.profile?.full_name?.split(' ')[0],
          onClick: () => setSelected(r),
        };
      });
  }, [fleet, staleSeconds]);

  const fit = React.useMemo<LatLng[]>(() => markers.map((m) => m.position), [markers]);

  const counts = React.useMemo(() => {
    const list = fleet ?? [];
    return {
      total: list.length,
      busy: list.filter((r) => r.availability === 'busy').length,
      stale: list.filter((r) => secondsSince(r.location?.last_seen) > staleSeconds).length,
    };
  }, [fleet, staleSeconds]);

  return (
    <AppShell title="Live fleet" fullBleed>
      <MapCanvas markers={markers} fit={fit} className="absolute inset-0">
        <div className="pointer-events-none absolute inset-x-3 top-20 z-20">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-card backdrop-blur">
            {isLoading ? (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading fleet
              </span>
            ) : (
              <>
                <Badge variant="success">{counts.total - counts.busy} available</Badge>
                <Badge variant="warning">{counts.busy} on a ride</Badge>
                {counts.stale > 0 && (
                  <Badge variant="destructive">
                    <Satellite className="h-3 w-3" />
                    {counts.stale} stale
                  </Badge>
                )}
                <span className="ml-auto text-[11px] text-muted-foreground">
                  tap a marker for details
                </span>
              </>
            )}
          </div>
        </div>

        {!isLoading && !markers.length && (
          <div className="absolute inset-x-3 bottom-24 z-20 rounded-xl border border-border bg-card/95 p-4 text-center shadow-card backdrop-blur">
            <p className="text-sm font-semibold">No riders online</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Riders appear here as soon as they go online and share a position.
            </p>
          </div>
        )}
      </MapCanvas>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="bottom" className="pb-safe">
          <SheetHeader>
            <SheetTitle>{selected?.profile?.full_name || 'Rider'}</SheetTitle>
          </SheetHeader>
          {selected && (
            <div className="space-y-3 px-5 pb-5">
              <div className="flex flex-wrap items-center gap-2">
                <AvailabilityBadge
                  availability={selected.availability}
                  stale={secondsSince(selected.location?.last_seen) > staleSeconds}
                />
                {!selected.is_active && <Badge variant="destructive">Deactivated</Badge>}
                {selected.vehicles[0] && (
                  <Badge variant="outline" className="font-mono tracking-wider">
                    {selected.vehicles[0].plate_number}
                  </Badge>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Detail label="Phone" value={selected.profile?.phone ?? '--'} />
                <Detail label="Rating" value={Number(selected.rating).toFixed(1)} />
                <Detail label="Total rides" value={String(selected.total_rides)} />
                <Detail
                  label="Last fix"
                  value={
                    selected.location?.last_seen
                      ? formatDistanceToNow(new Date(selected.location.last_seen), {
                          addSuffix: true,
                        })
                      : 'never'
                  }
                />
                <Detail
                  label="Accuracy"
                  value={
                    selected.location?.accuracy != null
                      ? `${Math.round(selected.location.accuracy)} m`
                      : '--'
                  }
                />
                <Detail
                  label="Speed"
                  value={
                    selected.location?.speed != null
                      ? `${Math.round(selected.location.speed * 3.6)} km/h`
                      : '--'
                  }
                />
              </dl>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary p-2.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 truncate font-medium">{value}</dd>
    </div>
  );
}
