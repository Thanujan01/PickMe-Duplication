import maplibregl, { type LngLatBoundsLike, type Map as MlMap, type Marker } from 'maplibre-gl';
import { env } from '@/lib/env';
import { boundsOf, isValidLatLng, type LatLng } from '@/lib/geo';
import { createMarkerElement, updateMarkerElement } from './markerElement';
import { ROUTE_STYLE, type MapAdapter, type MapAdapterInit, type MapMarker, type MapRoute } from './types';

/**
 * Default provider: MapLibre GL over OpenStreetMap raster tiles.
 *
 * Chosen as the default because it needs no API key and no billing account,
 * which keeps the whole platform free to run. Set VITE_MAPLIBRE_STYLE_URL to
 * point at a vector style (e.g. a MapTiler free key) for a nicer basemap.
 */

const OSM_RASTER_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#eef1f5' } },
    { id: 'osm', type: 'raster', source: 'osm' },
  ],
};

const ROUTE_SOURCE = 'app-routes';

export function createMapLibreAdapter(init: MapAdapterInit): MapAdapter {
  const map: MlMap = new maplibregl.Map({
    container: init.container,
    style: env.maplibreStyleUrl || OSM_RASTER_STYLE,
    center: [init.center.lng, init.center.lat],
    zoom: init.zoom,
    interactive: init.interactive,
    attributionControl: { compact: true },
    // Tiles are the dominant cost on a phone; cap pixel ratio.
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  });

  if (init.interactive) {
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  }
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();

  const markers = new Map<string, { marker: Marker; spec: MapMarker }>();
  let routes: MapRoute[] = [];
  let ready = false;
  let destroyed = false;

  const routeCollection = (): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: routes
      .filter((r) => r.path.length > 1)
      .map((r) => ({
        type: 'Feature' as const,
        properties: { variant: r.variant ?? 'primary' },
        geometry: {
          type: 'LineString' as const,
          coordinates: r.path.filter(isValidLatLng).map((p) => [p.lng, p.lat]),
        },
      })),
  });

  const syncRoutes = () => {
    if (!ready || destroyed) return;
    const source = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(routeCollection());
  };

  map.on('load', () => {
    if (destroyed) return;
    ready = true;

    map.addSource(ROUTE_SOURCE, { type: 'geojson', data: routeCollection() });

    // Casing underneath gives the line definition against busy tiles.
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ROUTE_STYLE.primary.width + 4,
        'line-opacity': 0.85,
      },
    });

    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': [
          'match',
          ['get', 'variant'],
          'ghost',
          ROUTE_STYLE.ghost.color,
          ROUTE_STYLE.primary.color,
        ],
        'line-width': [
          'match',
          ['get', 'variant'],
          'ghost',
          ROUTE_STYLE.ghost.width,
          ROUTE_STYLE.primary.width,
        ],
        'line-opacity': [
          'match',
          ['get', 'variant'],
          'ghost',
          ROUTE_STYLE.ghost.opacity,
          ROUTE_STYLE.primary.opacity,
        ],
        'line-dasharray': ['match', ['get', 'variant'], 'ghost', ['literal', [2, 1.6]], ['literal', [1]]],
      },
    });

    syncRoutes();
    init.onReady?.();
  });

  map.on('error', (e) => {
    // Tile failures are common on flaky mobile data and must not be fatal.
    const message = (e as unknown as { error?: { message?: string } }).error?.message ?? 'Map error';
    init.onError?.(message);
  });

  if (init.onMapClick) {
    map.on('click', (e) => init.onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
  }

  if (init.onMoveEnd) {
    map.on('moveend', () => {
      const c = map.getCenter();
      init.onMoveEnd?.({ lat: c.lat, lng: c.lng });
    });
  }

  return {
    setMarkers(next) {
      if (destroyed) return;
      const seen = new Set<string>();

      for (const spec of next) {
        if (!isValidLatLng(spec.position)) continue;
        seen.add(spec.id);
        const existing = markers.get(spec.id);

        if (existing) {
          existing.marker.setLngLat([spec.position.lng, spec.position.lat]);
          updateMarkerElement(existing.marker.getElement(), spec);
          existing.spec = spec;
          continue;
        }

        const marker = new maplibregl.Marker({
          element: createMarkerElement(spec),
          anchor: 'center',
        })
          .setLngLat([spec.position.lng, spec.position.lat])
          .addTo(map);

        markers.set(spec.id, { marker, spec });
      }

      for (const [id, entry] of markers) {
        if (!seen.has(id)) {
          entry.marker.remove();
          markers.delete(id);
        }
      }
    },

    setRoutes(next) {
      routes = next;
      syncRoutes();
    },

    flyTo(position, zoom) {
      if (destroyed || !isValidLatLng(position)) return;
      map.easeTo({
        center: [position.lng, position.lat],
        zoom: zoom ?? map.getZoom(),
        duration: 650,
      });
    },

    fitPoints(points, paddingPx = 64) {
      if (destroyed) return;
      const b = boundsOf(points);
      if (!b) return;

      if (b.north === b.south && b.east === b.west) {
        map.easeTo({ center: [b.east, b.north], zoom: Math.max(map.getZoom(), 15), duration: 650 });
        return;
      }

      const bounds: LngLatBoundsLike = [
        [b.west, b.south],
        [b.east, b.north],
      ];
      map.fitBounds(bounds, { padding: paddingPx, duration: 650, maxZoom: 16.5 });
    },

    getCenter(): LatLng {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng };
    },

    resize() {
      if (!destroyed) map.resize();
    },

    destroy() {
      destroyed = true;
      for (const [, entry] of markers) entry.marker.remove();
      markers.clear();
      map.remove();
    },
  };
}
