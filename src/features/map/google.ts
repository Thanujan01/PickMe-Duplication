import { env } from '@/lib/env';
import { isValidLatLng, type LatLng } from '@/lib/geo';
import { MARKER_STYLE, ROUTE_STYLE, type MapAdapter, type MapAdapterInit, type MapMarker } from './types';

/**
 * Google Maps provider. Enabled by setting VITE_MAP_PROVIDER=google and
 * supplying VITE_GOOGLE_MAPS_API_KEY (Maps JavaScript API must be enabled on
 * the key). Markers use google.maps.Symbol rather than AdvancedMarkerElement
 * so no Map ID / cloud-styling setup is required.
 */

let loaderPromise: Promise<void> | null = null;

export function loadGoogleMaps(): Promise<void> {
  if (typeof window !== 'undefined' && window.google?.maps) return Promise.resolve();
  if (loaderPromise) return loaderPromise;

  if (!env.googleMapsApiKey) {
    return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not set.'));
  }

  loaderPromise = new Promise<void>((resolve, reject) => {
    const callbackName = '__rideAppGoogleMapsReady';
    (window as unknown as Record<string, unknown>)[callbackName] = () => resolve();

    const script = document.createElement('script');
    const params = new URLSearchParams({
      key: env.googleMapsApiKey,
      v: 'weekly',
      libraries: 'geometry,places',
      callback: callbackName,
      loading: 'async',
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => {
      loaderPromise = null;
      reject(new Error('Could not load Google Maps. Check the API key and its referrer restrictions.'));
    };
    document.head.appendChild(script);
  });

  return loaderPromise;
}

/** A filled circle, or a rotated arrow when the marker is directional. */
function symbolFor(marker: MapMarker): google.maps.Symbol {
  const style = MARKER_STYLE[marker.kind];
  const directional = style.directional && marker.heading != null && Number.isFinite(marker.heading);

  if (directional) {
    return {
      path: 'M 0,-12 L 7.5,9 L 0,4.5 L -7.5,9 Z',
      fillColor: style.fill,
      fillOpacity: 1,
      strokeColor: style.ring,
      strokeWeight: 2,
      rotation: marker.heading as number,
      scale: style.size / 18,
      anchor: new google.maps.Point(0, 0),
    };
  }

  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: style.fill,
    fillOpacity: 1,
    strokeColor: style.ring,
    strokeWeight: 2.5,
    scale: style.size / 2,
  };
}

export async function createGoogleAdapter(init: MapAdapterInit): Promise<MapAdapter> {
  await loadGoogleMaps();

  const map = new google.maps.Map(init.container, {
    center: { lat: init.center.lat, lng: init.center.lng },
    zoom: init.zoom,
    disableDefaultUI: !init.interactive,
    zoomControl: init.interactive,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    rotateControl: false,
    gestureHandling: init.interactive ? 'greedy' : 'none',
    clickableIcons: false,
    // Mirror the restrained MapLibre basemap: roads, not points of interest.
    styles: [
      { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    ],
  });

  const markers = new Map<string, { marker: google.maps.Marker; spec: MapMarker }>();
  const polylines = new Map<string, google.maps.Polyline>();
  let destroyed = false;

  const listeners: google.maps.MapsEventListener[] = [];

  if (init.onMapClick) {
    listeners.push(
      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (e.latLng) init.onMapClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      }),
    );
  }

  if (init.onMoveEnd) {
    listeners.push(
      map.addListener('idle', () => {
        const c = map.getCenter();
        if (c) init.onMoveEnd?.({ lat: c.lat(), lng: c.lng() });
      }),
    );
  }

  // `idle` is the closest Google equivalent of MapLibre's `load`.
  google.maps.event.addListenerOnce(map, 'idle', () => {
    if (!destroyed) init.onReady?.();
  });

  return {
    setMarkers(next) {
      if (destroyed) return;
      const seen = new Set<string>();

      for (const spec of next) {
        if (!isValidLatLng(spec.position)) continue;
        seen.add(spec.id);
        const existing = markers.get(spec.id);
        const position = { lat: spec.position.lat, lng: spec.position.lng };

        if (existing) {
          existing.marker.setPosition(position);
          if (
            existing.spec.heading !== spec.heading ||
            existing.spec.kind !== spec.kind ||
            existing.spec.label !== spec.label
          ) {
            existing.marker.setIcon(symbolFor(spec));
            existing.marker.setLabel(
              spec.label ? { text: spec.label, fontSize: '11px', fontWeight: '600' } : null,
            );
          }
          existing.spec = spec;
          continue;
        }

        const marker = new google.maps.Marker({
          map,
          position,
          icon: symbolFor(spec),
          zIndex: MARKER_STYLE[spec.kind].z,
          label: spec.label ? { text: spec.label, fontSize: '11px', fontWeight: '600' } : null,
          optimized: false,
        });

        if (spec.onClick) marker.addListener('click', () => spec.onClick?.());
        markers.set(spec.id, { marker, spec });
      }

      for (const [id, entry] of markers) {
        if (!seen.has(id)) {
          entry.marker.setMap(null);
          markers.delete(id);
        }
      }
    },

    setRoutes(next) {
      if (destroyed) return;
      const seen = new Set<string>();

      for (const route of next) {
        const path = route.path.filter(isValidLatLng).map((p) => ({ lat: p.lat, lng: p.lng }));
        if (path.length < 2) continue;
        seen.add(route.id);

        const style = ROUTE_STYLE[route.variant ?? 'primary'];
        const existing = polylines.get(route.id);

        if (existing) {
          existing.setPath(path);
          continue;
        }

        polylines.set(
          route.id,
          new google.maps.Polyline({
            map,
            path,
            strokeColor: style.color,
            strokeWeight: style.width,
            strokeOpacity: style.dashed ? 0 : style.opacity,
            icons: style.dashed
              ? [
                  {
                    icon: { path: 'M 0,-1 0,1', strokeOpacity: style.opacity, scale: 3 },
                    offset: '0',
                    repeat: '12px',
                  },
                ]
              : undefined,
            zIndex: route.variant === 'ghost' ? 5 : 6,
          }),
        );
      }

      for (const [id, line] of polylines) {
        if (!seen.has(id)) {
          line.setMap(null);
          polylines.delete(id);
        }
      }
    },

    flyTo(position, zoom) {
      if (destroyed || !isValidLatLng(position)) return;
      map.panTo({ lat: position.lat, lng: position.lng });
      if (zoom != null) map.setZoom(zoom);
    },

    fitPoints(points, paddingPx = 64) {
      if (destroyed) return;
      const valid = points.filter(isValidLatLng);
      if (!valid.length) return;

      if (valid.length === 1) {
        map.panTo({ lat: valid[0].lat, lng: valid[0].lng });
        map.setZoom(Math.max(map.getZoom() ?? 14, 15));
        return;
      }

      const bounds = new google.maps.LatLngBounds();
      for (const p of valid) bounds.extend({ lat: p.lat, lng: p.lng });
      map.fitBounds(bounds, paddingPx);
    },

    getCenter(): LatLng {
      const c = map.getCenter();
      return c ? { lat: c.lat(), lng: c.lng() } : init.center;
    },

    resize() {
      if (!destroyed) google.maps.event.trigger(map, 'resize');
    },

    destroy() {
      destroyed = true;
      for (const l of listeners) l.remove();
      for (const [, entry] of markers) entry.marker.setMap(null);
      for (const [, line] of polylines) line.setMap(null);
      markers.clear();
      polylines.clear();
    },
  };
}
