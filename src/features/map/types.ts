import type { LatLng } from '@/lib/geo';

/**
 * The map contract. Everything the app needs from a map lives here, so a
 * provider can be swapped by configuration alone (spec section 9: "provide a
 * configuration layer so the map provider can be changed later").
 *
 * The API is declarative: React hands over the full desired set of markers and
 * routes, and the adapter diffs against what is already on screen.
 */

export type MarkerKind = 'pickup' | 'destination' | 'rider' | 'user' | 'fleet' | 'fleet-busy' | 'fleet-stale';

export interface MapMarker {
  id: string;
  position: LatLng;
  kind: MarkerKind;
  /** Degrees from north; rotates directional markers when present. */
  heading?: number | null;
  /** Short text badge beside the marker. */
  label?: string;
  /** Draws an animated halo. Used for the live rider and active pickup. */
  pulse?: boolean;
  onClick?: () => void;
}

export interface MapRoute {
  id: string;
  path: LatLng[];
  /** `primary` is the active route; `ghost` is a dashed secondary leg. */
  variant?: 'primary' | 'ghost';
}

export interface MapAdapterInit {
  container: HTMLElement;
  center: LatLng;
  zoom: number;
  interactive: boolean;
  onReady?: () => void;
  onError?: (message: string) => void;
  /** Fires when the person taps the map, for drop-pin selection. */
  onMapClick?: (position: LatLng) => void;
  /** Fires after a pan/zoom settles, for centre-pin selection. */
  onMoveEnd?: (center: LatLng) => void;
}

export interface MapAdapter {
  setMarkers(markers: MapMarker[]): void;
  setRoutes(routes: MapRoute[]): void;
  flyTo(position: LatLng, zoom?: number): void;
  fitPoints(points: LatLng[], paddingPx?: number): void;
  getCenter(): LatLng;
  resize(): void;
  destroy(): void;
}

/** Shared visual language so both providers render the same map. */
export const MARKER_STYLE: Record<
  MarkerKind,
  { fill: string; ring: string; size: number; directional: boolean; z: number }
> = {
  pickup: { fill: '#10b981', ring: '#ffffff', size: 18, directional: false, z: 30 },
  destination: { fill: '#0f172a', ring: '#ffffff', size: 18, directional: false, z: 29 },
  rider: { fill: '#2563eb', ring: '#ffffff', size: 22, directional: true, z: 40 },
  user: { fill: '#3b82f6', ring: '#ffffff', size: 14, directional: false, z: 20 },
  fleet: { fill: '#10b981', ring: '#ffffff', size: 16, directional: true, z: 25 },
  'fleet-busy': { fill: '#f59e0b', ring: '#ffffff', size: 16, directional: true, z: 24 },
  'fleet-stale': { fill: '#94a3b8', ring: '#ffffff', size: 14, directional: false, z: 23 },
};

export const ROUTE_STYLE = {
  primary: { color: '#1d4ed8', width: 5, opacity: 0.9, dashed: false },
  ghost: { color: '#64748b', width: 4, opacity: 0.65, dashed: true },
} as const;
