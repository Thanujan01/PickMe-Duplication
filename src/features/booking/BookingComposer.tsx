import { Bike, Car, Clock, Loader2, Route as RouteIcon, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn, estimateFare, formatDistance, formatDuration, formatMoney } from '@/lib/utils';
import type { Place } from '@/lib/geo';
import type { RouteResult } from '@/features/map/routing';
import { PlaceRow } from '@/components/shared/PlaceRow';
import type { VehicleType } from '@/types/database';

const VEHICLES: { value: VehicleType; label: string; icon: typeof Car; multiplier: number }[] = [
  { value: 'bike', label: 'Bike', icon: Bike, multiplier: 0.6 },
  { value: 'tuk', label: 'Tuk', icon: Car, multiplier: 0.8 },
  { value: 'car', label: 'Car', icon: Car, multiplier: 1 },
  { value: 'van', label: 'Van', icon: Truck, multiplier: 1.5 },
];

/**
 * The booking sheet: pickup, destination, estimate, confirm.
 *
 * Fares shown here are a local preview. create_booking() recomputes the fare
 * server-side from admin_settings, so this can never be gamed by a client.
 */
export function BookingComposer({
  pickup,
  destination,
  route,
  routing,
  vehicleType,
  onVehicleType,
  onEditPickup,
  onEditDestination,
  onSubmit,
  submitting,
}: {
  pickup: Place | null;
  destination: Place | null;
  route: RouteResult | null;
  routing: boolean;
  vehicleType: VehicleType;
  onVehicleType: (v: VehicleType) => void;
  onEditPickup: () => void;
  onEditDestination: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const ready = !!pickup && !!destination;
  const baseFare = estimateFare(route?.distance ?? null, route?.duration ?? null);

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 p-3 pb-20">
      <div className="animate-slide-up rounded-2xl border border-border bg-card shadow-sheet">
        <div className="px-4 pt-3">
          <PlaceRow kind="pickup" label="Pickup" value={pickup?.address ?? null} onClick={onEditPickup} />
          <Separator className="my-1 ml-10 w-auto" />
          <PlaceRow
            kind="destination"
            label="Destination"
            value={destination?.address ?? null}
            onClick={onEditDestination}
          />
        </div>

        {ready && (
          <>
            <Separator className="mt-2" />

            {/* Estimate strip (spec section 5 step 6) */}
            <div className="flex items-center gap-4 px-4 py-3">
              {routing ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Working out your route…
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-sm">
                    <RouteIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="tabular font-semibold">{formatDistance(route?.distance)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="tabular font-semibold">{formatDuration(route?.duration)}</span>
                  </div>
                  {route?.approximate && (
                    <span className="text-[11px] text-muted-foreground">estimated</span>
                  )}
                </>
              )}
            </div>

            <Separator />

            {/* Vehicle class */}
            <div className="grid grid-cols-4 gap-2 px-4 py-3">
              {VEHICLES.map(({ value, label, icon: Icon, multiplier }) => {
                const selected = vehicleType === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onVehicleType(value)}
                    aria-pressed={selected}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-xl border p-2.5 transition',
                      selected
                        ? 'border-primary bg-secondary ring-1 ring-primary'
                        : 'border-border hover:bg-secondary/60',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="text-[11px] font-semibold">{label}</span>
                    <span className="tabular text-[10px] text-muted-foreground">
                      {baseFare == null ? '--' : formatMoney(Math.round(baseFare * multiplier))}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="px-4 pb-4 pt-1">
          <Button
            size="lg"
            className="w-full"
            disabled={!ready || routing}
            loading={submitting}
            onClick={onSubmit}
          >
            {ready ? 'Book ride' : 'Choose your destination'}
          </Button>
          {ready && !routing && (
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              We contact the nearest rider first, then the next, every 10 seconds.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
