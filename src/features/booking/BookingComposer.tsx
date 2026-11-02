import { Bus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { RouteVisual } from '@/components/shared/RouteVisual';
import type { Place } from '@/lib/geo';
import type { RouteResult } from '@/features/map/routing';

/**
 * The booking sheet: where from, where to, then confirm.
 *
 * There is no vehicle choice - the platform runs buses only - and no fare,
 * so the whole panel is the journey plus one button.
 */
export function BookingComposer({
  pickup,
  destination,
  route,
  routing,
  onEditPickup,
  onEditDestination,
  onSubmit,
  submitting,
}: {
  pickup: Place | null;
  destination: Place | null;
  route: RouteResult | null;
  routing: boolean;
  onEditPickup: () => void;
  onEditDestination: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const ready = !!pickup && !!destination;

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 p-3 pb-20">
      <div className="animate-slide-up rounded-2xl border border-border bg-card shadow-sheet">
        <div className="px-4 pt-4">
          <RouteVisual
            pickup={pickup?.address ?? null}
            destination={destination?.address ?? null}
            distanceM={ready && !routing ? route?.distance : null}
            durationS={ready && !routing ? route?.duration : null}
            pending
            onPickupClick={onEditPickup}
            onDestinationClick={onEditDestination}
          />

          {ready && routing && (
            <div className="flex items-center gap-2 pt-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working out your route…
            </div>
          )}

          {ready && !routing && route?.approximate && (
            <p className="pt-2 text-[11px] text-muted-foreground">
              Estimated — the routing service was unreachable, so this is a direct-line guess.
            </p>
          )}
        </div>

        <Separator className="mt-4" />

        <div className="flex items-center gap-2.5 px-4 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary">
            <Bus className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Bus</p>
            <p className="text-xs text-muted-foreground">Nearest available bus on your route</p>
          </div>
        </div>

        <div className="px-4 pb-4">
          <Button
            size="lg"
            className="w-full"
            disabled={!ready || routing}
            loading={submitting}
            onClick={onSubmit}
          >
            {ready ? 'Book bus' : 'Choose your destination'}
          </Button>
          {ready && !routing && (
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              We contact the nearest driver first, then the next, every 10 seconds.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
