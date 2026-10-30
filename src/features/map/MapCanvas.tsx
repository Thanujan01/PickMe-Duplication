import * as React from 'react';
import { MapPinOff } from 'lucide-react';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';
import type { LatLng } from '@/lib/geo';
import { createMapLibreAdapter } from './maplibre';
import { createGoogleAdapter } from './google';
import type { MapAdapter, MapMarker, MapRoute } from './types';

/** Shared frozen empties: a fresh [] literal per render would re-diff the map. */
export const NO_MARKERS: MapMarker[] = [];
export const NO_ROUTES: MapRoute[] = [];

export interface MapCanvasProps {
  markers?: MapMarker[];
  routes?: MapRoute[];
  center?: LatLng;
  zoom?: number;
  interactive?: boolean;
  /** Points to keep in view. Re-fits whenever the signature changes. */
  fit?: LatLng[];
  onMapClick?: (p: LatLng) => void;
  onMoveEnd?: (center: LatLng) => void;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Provider-agnostic map surface. Mounts the adapter named by
 * VITE_MAP_PROVIDER and keeps it in step with declarative props.
 */
export function MapCanvas({
  markers = NO_MARKERS,
  routes = NO_ROUTES,
  center,
  zoom,
  interactive = true,
  fit,
  onMapClick,
  onMoveEnd,
  className,
  children,
}: MapCanvasProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const adapterRef = React.useRef<MapAdapter | null>(null);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Callbacks are kept in refs so changing a handler never remounts the map.
  const clickRef = React.useRef(onMapClick);
  const moveRef = React.useRef(onMoveEnd);
  clickRef.current = onMapClick;
  moveRef.current = onMoveEnd;

  const initialCenter = React.useRef(center ?? env.defaultCenter);
  const initialZoom = React.useRef(zoom ?? env.defaultZoom);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    const init = {
      container,
      center: initialCenter.current,
      zoom: initialZoom.current,
      interactive,
      onReady: () => !cancelled && setReady(true),
      onError: (m: string) => !cancelled && setError(m),
      onMapClick: (p: LatLng) => clickRef.current?.(p),
      onMoveEnd: (p: LatLng) => moveRef.current?.(p),
    };

    const mount = async () => {
      try {
        const adapter =
          env.mapProvider === 'google'
            ? await createGoogleAdapter(init)
            : createMapLibreAdapter(init);

        if (cancelled) {
          adapter.destroy();
          return;
        }
        adapterRef.current = adapter;
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the map.');
      }
    };

    void mount();

    // Bottom sheets and keyboards change the viewport constantly on mobile.
    const observer = new ResizeObserver(() => adapterRef.current?.resize());
    observer.observe(container);

    return () => {
      cancelled = true;
      observer.disconnect();
      adapterRef.current?.destroy();
      adapterRef.current = null;
      setReady(false);
    };
    // `interactive` is a mount-time concern; changing it would need a remount.
  }, [interactive]);

  React.useEffect(() => {
    if (ready) adapterRef.current?.setMarkers(markers);
  }, [markers, ready]);

  React.useEffect(() => {
    if (ready) adapterRef.current?.setRoutes(routes);
  }, [routes, ready]);

  React.useEffect(() => {
    if (ready && center) adapterRef.current?.flyTo(center, zoom);
  }, [center, zoom, ready]);

  // Rounded signature: avoids re-fitting on every sub-metre GPS jitter.
  const fitKey = React.useMemo(
    () => (fit ?? []).map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|'),
    [fit],
  );

  React.useEffect(() => {
    if (!ready || !fit?.length) return;
    adapterRef.current?.fitPoints(fit, 72);
    // fitKey is the intentional dependency; `fit` identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-muted', className)}>
      <div ref={containerRef} className="absolute inset-0" />

      {error && (
        <div className="absolute inset-x-3 top-3 z-10 flex items-start gap-2.5 rounded-xl border border-border bg-card/95 p-3 shadow-card backdrop-blur">
          <MapPinOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Map unavailable</p>
            <p className="text-xs text-muted-foreground">{error}</p>
            {env.mapProvider === 'google' && (
              <p className="mt-1 text-xs text-muted-foreground">
                Set <code className="rounded bg-muted px-1">VITE_MAP_PROVIDER=maplibre</code> to use the
                keyless OpenStreetMap basemap.
              </p>
            )}
          </div>
        </div>
      )}

      {!ready && !error && (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-muted to-secondary" aria-hidden />
      )}

      {children}
    </div>
  );
}
