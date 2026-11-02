import * as React from 'react';
import { Crosshair, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/shared/AppShell';
import { Button } from '@/components/ui/button';
import { env } from '@/lib/env';
import { isValidLatLng, type LatLng, type Place } from '@/lib/geo';
import { newIdempotencyKey } from '@/lib/utils';
import { MapCanvas } from '@/features/map/MapCanvas';
import type { MapMarker, MapRoute } from '@/features/map/types';
import { reverseGeocode } from '@/features/map/geocoding';
import { getRoute, type RouteResult } from '@/features/map/routing';
import { useGeolocation } from '@/features/gps/useGeolocation';
import { useActiveCustomerBooking, useCreateBooking } from '@/features/booking/hooks';
import { MapPinConfirm, PlaceSearchSheet } from '@/features/booking/PlaceSearchSheet';
import { BookingComposer } from '@/features/booking/BookingComposer';
import { RideTracker } from '@/features/booking/RideTracker';
import { useTrackingLayers } from '@/features/booking/useTrackingLayers';

type PinTarget = 'pickup' | 'destination';

/**
 * The customer's single screen: a full-bleed map that is either composing a
 * booking or tracking a live one. "One live booking at a time" is a database
 * invariant (unique partial index in migration 0002), so this switch is safe.
 */
export default function CustomerHome() {
  const { data: active, isLoading: loadingActive } = useActiveCustomerBooking();
  const { fix, permission, error: gpsError, request } = useGeolocation(false);

  const [pickup, setPickup] = React.useState<Place | null>(null);
  const [destination, setDestination] = React.useState<Place | null>(null);

  const [searchFor, setSearchFor] = React.useState<PinTarget | null>(null);
  const [pinMode, setPinMode] = React.useState<PinTarget | null>(null);
  const [pinCenter, setPinCenter] = React.useState<LatLng | null>(null);

  const [route, setRoute] = React.useState<RouteResult | null>(null);
  const [routing, setRouting] = React.useState(false);

  const createBooking = useCreateBooking();
  // One key per booking intent: retrying after a network blip must not create
  // a second ride (spec section 15).
  const idempotencyKey = React.useRef(newIdempotencyKey());
  const askedOnce = React.useRef(false);

  // Map layers for a live booking (markers, route, rider position, ETA).
  const layers = useTrackingLayers(active ?? null, active?.rider_id ?? null);

  // Steps 2-3 of the spec's flow: request permission on open, seed the pickup.
  React.useEffect(() => {
    if (askedOnce.current || active || loadingActive) return;
    askedOnce.current = true;
    void (async () => {
      const first = await request();
      if (!first) return;
      const address = await reverseGeocode(first);
      setPickup((current) => current ?? { lat: first.lat, lng: first.lng, address });
    })();
  }, [request, active, loadingActive]);

  // Trip estimate whenever either endpoint changes.
  React.useEffect(() => {
    if (!pickup || !destination) {
      setRoute(null);
      return;
    }
    let cancelled = false;
    setRouting(true);

    void getRoute(pickup, destination)
      .then((result) => {
        if (!cancelled) setRoute(result);
      })
      .finally(() => {
        if (!cancelled) setRouting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pickup, destination]);

  const useCurrentLocationFor = async (which: PinTarget) => {
    const next = fix ?? (await request());
    if (!next) {
      toast.error(gpsError ?? 'Could not read your location');
      return;
    }
    const address = await reverseGeocode(next);
    const place: Place = { lat: next.lat, lng: next.lng, address };
    if (which === 'pickup') setPickup(place);
    else setDestination(place);
  };

  const submit = async () => {
    if (!pickup || !destination) return;
    try {
      await createBooking.mutateAsync({
        pickup: { lat: pickup.lat, lng: pickup.lng, address: pickup.address },
        destination: { lat: destination.lat, lng: destination.lng, address: destination.address },
        estimatedDistance: route?.distance ?? null,
        estimatedDuration: route?.duration ?? null,
        vehicleType: 'bus',
        idempotencyKey: idempotencyKey.current,
      });
      // The active-booking query takes over and RideTracker renders.
      idempotencyKey.current = newIdempotencyKey();
      setDestination(null);
      setRoute(null);
    } catch {
      /* useCreateBooking already surfaced the message */
    }
  };

  // --- Map layers for the composing state ---------------------------------

  const composeMarkers = React.useMemo<MapMarker[]>(() => {
    const list: MapMarker[] = [];
    if (fix && isValidLatLng(fix) && !pickup) list.push({ id: 'me', position: fix, kind: 'user' });
    if (pickup) list.push({ id: 'pickup', position: pickup, kind: 'pickup', pulse: !destination });
    if (destination) list.push({ id: 'destination', position: destination, kind: 'destination' });
    return list;
  }, [fix, pickup, destination]);

  const composeRoutes = React.useMemo<MapRoute[]>(
    () => (route?.geometry.length ? [{ id: 'trip', path: route.geometry, variant: 'primary' }] : []),
    [route],
  );

  const composeFit = React.useMemo<LatLng[]>(() => {
    if (pinMode) return []; // the person is panning; do not fight them
    if (pickup && destination) return [pickup, destination];
    if (pickup) return [pickup];
    if (fix) return [fix];
    return [];
  }, [pinMode, pickup, destination, fix]);

  if (loadingActive) {
    return (
      <AppShell title="Ride" fullBleed>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={active ? 'Your ride' : 'Where to?'} fullBleed>
      <MapCanvas
        markers={active ? layers.markers : composeMarkers}
        routes={active ? layers.routes : composeRoutes}
        fit={active ? layers.fit : composeFit}
        onMoveEnd={pinMode ? setPinCenter : undefined}
        className="absolute inset-0"
      >
        {!active && !pinMode && (
          <Button
            variant="secondary"
            size="icon"
            aria-label="Centre on my location"
            onClick={() => void useCurrentLocationFor('pickup')}
            className="absolute right-3 top-20 z-20 bg-card/95 shadow-card backdrop-blur"
          >
            <Crosshair className="h-5 w-5" />
          </Button>
        )}

        {/* Any location problem, not just an outright denial. Without this the
            map just looks empty and there is nothing to act on. */}
        {!active && !pinMode && (gpsError || permission === 'denied' || permission === 'insecure') && (
          <div className="absolute inset-x-3 top-20 z-20 mr-14 flex items-start gap-2.5 rounded-xl border border-warning/40 bg-card/95 p-3 shadow-card backdrop-blur">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {permission === 'insecure' ? 'Location needs HTTPS' : "Can't read your location"}
              </p>
              <p className="text-xs text-muted-foreground">
                {gpsError ?? 'Allow location in your browser settings.'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                You can still book: tap <span className="font-medium">Pickup</span> and search for
                the address or drop a pin.
              </p>
            </div>
          </div>
        )}

        {pinMode ? (
          <MapPinConfirm
            center={pinCenter}
            label={pinMode === 'pickup' ? 'Set pickup point' : 'Set destination'}
            onConfirm={(place) => {
              if (pinMode === 'pickup') setPickup(place);
              else setDestination(place);
              setPinMode(null);
            }}
            onCancel={() => setPinMode(null)}
          />
        ) : active ? (
          <RideTracker booking={active} layers={layers} />
        ) : (
          <BookingComposer
            pickup={pickup}
            destination={destination}
            route={route}
            routing={routing}
            onEditPickup={() => setSearchFor('pickup')}
            onEditDestination={() => setSearchFor('destination')}
            onSubmit={submit}
            submitting={createBooking.isPending}
          />
        )}
      </MapCanvas>

      <PlaceSearchSheet
        open={searchFor !== null}
        onOpenChange={(open) => !open && setSearchFor(null)}
        title={searchFor === 'pickup' ? 'Set pickup point' : 'Where to?'}
        near={fix ?? pickup ?? env.defaultCenter}
        onPick={(place) => {
          if (searchFor === 'pickup') setPickup(place);
          else setDestination(place);
        }}
        onUseCurrentLocation={searchFor ? () => useCurrentLocationFor(searchFor) : undefined}
        onPickOnMap={() => {
          setPinCenter(fix ?? pickup ?? env.defaultCenter);
          setPinMode(searchFor);
        }}
      />
    </AppShell>
  );
}
