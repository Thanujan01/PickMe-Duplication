import * as React from 'react';
import { Clock, MapPin, Navigation2, Route as RouteIcon, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatDistance, formatDuration } from '@/lib/utils';
import type { RiderOffer } from './api';
import { useCountdown } from './hooks';

/**
 * The ride-request card (spec section 6).
 *
 * The countdown is rendered from the server's `expires_at`, which is the only
 * authority on the deadline. If this tab were asleep or the clock skewed, the
 * card simply disappears when the server-side value lapses - accept() is
 * re-validated on the server regardless of what this timer shows.
 */
export function OfferCard({
  offer,
  windowSeconds,
  onAccept,
  onReject,
  accepting,
  rejecting,
}: {
  offer: RiderOffer;
  windowSeconds: number;
  onAccept: () => void;
  onReject: () => void;
  accepting: boolean;
  rejecting: boolean;
}) {
  const remaining = useCountdown(offer.dispatch.expires_at);
  const fraction = Math.max(0, Math.min(1, remaining / Math.max(windowSeconds, 1)));

  // Nudge the device once when the card appears.
  const buzzed = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (buzzed.current === offer.dispatch.id) return;
    buzzed.current = offer.dispatch.id;
    try {
      navigator.vibrate?.([200, 80, 200]);
    } catch {
      /* unsupported */
    }
  }, [offer.dispatch.id]);

  return (
    <div className="absolute inset-x-0 bottom-0 z-40 p-3 pb-20">
      <div className="animate-slide-up overflow-hidden rounded-2xl border-2 border-accent bg-card shadow-sheet">
        {/* Countdown bar: the whole card's urgency in one element. */}
        <div className="h-1.5 w-full bg-muted">
          <div
            className="h-full bg-accent transition-[width] duration-200 ease-linear"
            style={{ width: `${fraction * 100}%` }}
            role="progressbar"
            aria-label="Time remaining to respond"
            aria-valuenow={remaining}
            aria-valuemin={0}
            aria-valuemax={windowSeconds}
          />
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15">
                <UserRound className="h-4 w-4 text-accent" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{offer.customerName}</p>
                <p className="text-xs text-muted-foreground">
                  Request #{offer.dispatch.sequence}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="tabular text-2xl font-bold leading-none">{remaining}</p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">seconds</p>
            </div>
          </div>

          <Separator className="my-3" />

          <div className="space-y-2.5">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/12 text-success">
                <MapPin className="h-3 w-3" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Pickup · {formatDistance(offer.dispatch.distance_m)} away
                </p>
                <p className="truncate text-sm">{offer.booking.pickup_address || 'Nearby pickup'}</p>
              </div>
            </div>

            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary">
                <Navigation2 className="h-3 w-3" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Drop-off
                </p>
                <p className="truncate text-sm">
                  {offer.booking.destination_address || 'Destination'}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-4 rounded-xl bg-secondary px-3 py-2.5 text-sm">
            <span className="flex items-center gap-1.5">
              <RouteIcon className="h-4 w-4 text-muted-foreground" />
              <span className="tabular font-semibold">
                {formatDistance(offer.booking.estimated_distance)}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="tabular font-semibold">
                {formatDuration(offer.booking.estimated_duration)}
              </span>
            </span>
          </div>

          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              size="lg"
              className="flex-1"
              onClick={onReject}
              loading={rejecting}
              disabled={accepting}
            >
              Decline
            </Button>
            <Button
              variant="accent"
              size="lg"
              className="flex-[1.6]"
              onClick={onAccept}
              loading={accepting}
              disabled={rejecting || remaining <= 0}
            >
              Accept ride
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
