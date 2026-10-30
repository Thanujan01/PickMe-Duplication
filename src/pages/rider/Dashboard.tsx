import * as React from 'react';
import {
  AlertTriangle,
  Car,
  CircleDollarSign,
  Loader2,
  Power,
  Satellite,
  TrendingUp,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/shared/AppShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AvailabilityBadge } from '@/components/shared/StatusBadge';
import { cn, formatMoney } from '@/lib/utils';
import { isValidLatLng } from '@/lib/geo';
import { MapCanvas, NO_ROUTES } from '@/features/map/MapCanvas';
import type { MapMarker } from '@/features/map/types';
import { useRiderTracker } from '@/features/gps/useRiderTracker';
import { useActiveRiderBooking } from '@/features/booking/hooks';
import { useTrackingLayers } from '@/features/booking/useTrackingLayers';
import {
  useAcceptOffer,
  useCurrentOffer,
  useMyRider,
  useMyVehicles,
  useRejectOffer,
  useRiderStats,
  useSetAvailability,
} from '@/features/dispatch/hooks';
import { OfferCard } from '@/features/dispatch/OfferCard';
import { ActiveRidePanel } from '@/features/dispatch/ActiveRidePanel';
import { usePublicSettings } from '@/features/settings/hooks';
import { requestPushPermission, pushPermission } from '@/features/notifications/push';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * The rider's home screen.
 *
 * Going online is gated on a usable GPS fix: set_rider_availability() refuses
 * 'online' without a recent location row, because dispatch ranks candidates by
 * position and a stale rider would get offers it cannot serve.
 */
export default function RiderDashboard() {
  const { user } = useAuth();
  const { data: rider, isLoading: loadingRider } = useMyRider();
  const { data: vehicles } = useMyVehicles();
  const { data: stats } = useRiderStats();
  const { data: settings } = usePublicSettings();
  const setAvailability = useSetAvailability();

  const online = rider?.availability === 'online' || rider?.availability === 'busy';
  const tracker = useRiderTracker(online);

  const { data: activeBooking } = useActiveRiderBooking();
  const layers = useTrackingLayers(activeBooking ?? null, user?.id ?? null);

  // Offers only arrive while online and not already driving.
  const offerEnabled = rider?.availability === 'online' && !activeBooking;
  const { data: offer } = useCurrentOffer(!!offerEnabled);
  const accept = useAcceptOffer();
  const reject = useRejectOffer();

  const [goingOnline, setGoingOnline] = React.useState(false);

  const staleSeconds = settings?.gpsStaleSeconds ?? 45;
  const sinceSync = tracker.lastSyncedAt ? (Date.now() - tracker.lastSyncedAt) / 1000 : Infinity;
  const gpsStale = online && sinceSync > staleSeconds;

  // Ask for notification permission once the rider opts in to working.
  React.useEffect(() => {
    if (online && pushPermission() === 'default') void requestPushPermission();
  }, [online]);

  const toggle = async (next: boolean) => {
    if (!next) {
      setAvailability.mutate('offline');
      return;
    }

    setGoingOnline(true);
    try {
      // Push one fix first so the server has a fresh location to accept.
      const fix = tracker.fix ?? (await tracker.requestPermission());
      if (!fix) {
        toast.error(tracker.gpsError ?? 'We need your location before you can go online.');
        return;
      }
      const { pushRiderLocation } = await import('@/features/gps/api');
      await pushRiderLocation({
        latitude: fix.lat,
        longitude: fix.lng,
        heading: fix.heading,
        speed: fix.speed,
        accuracy: fix.accuracy,
      });
      setAvailability.mutate('online');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not go online');
    } finally {
      setGoingOnline(false);
    }
  };

  const ownMarker = React.useMemo<MapMarker[]>(() => {
    if (activeBooking) return layers.markers;
    if (!tracker.fix || !isValidLatLng(tracker.fix)) return [];
    return [
      {
        id: 'me',
        position: tracker.fix,
        kind: 'rider',
        heading: tracker.fix.heading,
        pulse: online,
      },
    ];
  }, [activeBooking, layers.markers, tracker.fix, online]);

  if (loadingRider) {
    return (
      <AppShell title="Drive" fullBleed>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  if (rider && !rider.is_active) {
    return (
      <AppShell title="Drive">
        <div className="mx-auto max-w-md p-6 text-center">
          <div className="mb-4 inline-flex rounded-full bg-destructive/10 p-3.5">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <p className="font-semibold">Your rider account is deactivated</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Contact an administrator to be reactivated. You will not receive ride requests until then.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Drive"
      fullBleed
      actions={
        <div className="flex items-center gap-2 rounded-xl bg-card/95 px-2.5 py-1.5 shadow-card backdrop-blur">
          {goingOnline ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : online ? (
            <Wifi className="h-4 w-4 text-success" />
          ) : (
            <WifiOff className="h-4 w-4 text-muted-foreground" />
          )}
          <Switch
            checked={online}
            disabled={goingOnline || setAvailability.isPending || rider?.availability === 'busy'}
            onCheckedChange={(next) => void toggle(next)}
            aria-label={online ? 'Go offline' : 'Go online'}
          />
        </div>
      }
    >
      <MapCanvas
        markers={ownMarker}
        routes={activeBooking ? layers.routes : NO_ROUTES}
        fit={activeBooking ? layers.fit : tracker.fix ? [tracker.fix] : []}
        className="absolute inset-0"
      >
        {/* Status strip */}
        <div className="pointer-events-none absolute inset-x-3 top-20 z-20 space-y-2">
          <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-card backdrop-blur">
            {rider && <AvailabilityBadge availability={rider.availability} stale={gpsStale} />}
            {online && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Satellite className={cn('h-3.5 w-3.5', gpsStale ? 'text-warning' : 'text-success')} />
                {tracker.lastSyncedAt
                  ? `synced ${Math.round(sinceSync)}s ago`
                  : 'waiting for GPS…'}
              </span>
            )}
            {!vehicles?.length && (
              <Badge variant="warning" className="ml-auto">
                No vehicle
              </Badge>
            )}
          </div>

          {tracker.syncError && (
            <div className="pointer-events-auto flex items-start gap-2 rounded-xl border border-destructive/30 bg-card/95 p-3 shadow-card backdrop-blur">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="text-xs text-muted-foreground">{tracker.syncError}</p>
            </div>
          )}

          {online && gpsStale && !tracker.syncError && (
            <div className="pointer-events-auto flex items-start gap-2 rounded-xl border border-warning/40 bg-card/95 p-3 shadow-card backdrop-blur">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-xs text-muted-foreground">
                Your location has not updated recently. Keep this screen open - phones stop GPS when
                the screen locks, and stale riders are skipped for new requests.
              </p>
            </div>
          )}
        </div>

        {/* Offer takes priority over everything else on screen. */}
        {offer ? (
          <OfferCard
            offer={offer}
            windowSeconds={settings?.dispatchWindowSeconds ?? 10}
            accepting={accept.isPending}
            rejecting={reject.isPending}
            onAccept={() => accept.mutate(offer.booking.id)}
            onReject={() => reject.mutate(offer.booking.id)}
          />
        ) : activeBooking ? (
          <ActiveRidePanel
            booking={activeBooking}
            riderPosition={tracker.fix}
            remainingDistance={layers.remainingDistance}
            etaSeconds={layers.etaSeconds}
          />
        ) : (
          <IdlePanel
            online={online}
            goingOnline={goingOnline}
            onGoOnline={() => void toggle(true)}
            stats={stats}
            hasVehicle={!!vehicles?.length}
          />
        )}
      </MapCanvas>
    </AppShell>
  );
}

function IdlePanel({
  online,
  goingOnline,
  onGoOnline,
  stats,
  hasVehicle,
}: {
  online: boolean;
  goingOnline: boolean;
  onGoOnline: () => void;
  stats: { rides_today: number; earnings_today: number; earnings_total: number; acceptance_rate: number | null } | undefined;
  hasVehicle: boolean;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-30 p-3 pb-20">
      <div className="animate-slide-up rounded-2xl border border-border bg-card p-4 shadow-sheet">
        <div className="grid grid-cols-3 gap-2">
          <Stat
            icon={Car}
            label="Rides today"
            value={String(stats?.rides_today ?? 0)}
          />
          <Stat
            icon={CircleDollarSign}
            label="Earned today"
            value={formatMoney(stats?.earnings_today ?? 0)}
          />
          <Stat
            icon={TrendingUp}
            label="Acceptance"
            value={stats?.acceptance_rate != null ? `${stats.acceptance_rate}%` : '--'}
          />
        </div>

        {online ? (
          <div className="mt-4 flex items-center justify-center gap-2.5 rounded-xl bg-success/10 py-3 text-sm font-medium text-success">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Waiting for ride requests
          </div>
        ) : (
          <>
            <Button size="lg" className="mt-4 w-full" loading={goingOnline} onClick={onGoOnline}>
              <Power className="h-4 w-4" />
              Go online
            </Button>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              {hasVehicle
                ? 'We will share your location only while you are online.'
                : 'Ask an administrator to add your vehicle so you can be matched.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Car;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl bg-secondary p-3 text-center">
      <Icon className="mx-auto h-4 w-4 text-muted-foreground" />
      <p className="tabular mt-1.5 truncate text-sm font-bold">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
