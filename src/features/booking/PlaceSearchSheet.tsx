import * as React from 'react';
import { Crosshair, Loader2, MapPin, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { EmptyState } from '@/components/shared/states';
import { cn } from '@/lib/utils';
import type { LatLng, Place } from '@/lib/geo';
import { reverseGeocode, searchPlaces, type SearchResult } from '@/features/map/geocoding';

const RECENTS_KEY = 'ride-recent-places';
const MAX_RECENTS = 5;

function loadRecents(): Place[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as Place[]).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function saveRecent(place: Place) {
  try {
    const existing = loadRecents().filter(
      (p) => Math.abs(p.lat - place.lat) > 1e-4 || Math.abs(p.lng - place.lng) > 1e-4,
    );
    localStorage.setItem(RECENTS_KEY, JSON.stringify([place, ...existing].slice(0, MAX_RECENTS)));
  } catch {
    /* private browsing: recents are a nicety, not a requirement */
  }
}

/**
 * Address search for a pickup or destination.
 *
 * Queries are debounced at 450 ms because the default geocoder is Nominatim,
 * whose usage policy rules out per-keystroke autocomplete.
 */
export function PlaceSearchSheet({
  open,
  onOpenChange,
  title,
  near,
  onPick,
  onUseCurrentLocation,
  onPickOnMap,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  near?: LatLng;
  onPick: (place: Place) => void;
  onUseCurrentLocation?: () => void | Promise<void>;
  onPickOnMap?: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [recents, setRecents] = React.useState<Place[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setRecents(loadRecents());
      setQuery('');
      setResults([]);
      setError(null);
      // Let the sheet animation finish before stealing focus.
      const t = setTimeout(() => inputRef.current?.focus(), 240);
      return () => clearTimeout(t);
    }
  }, [open]);

  React.useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const found = await searchPlaces(trimmed, near);
        if (!cancelled) {
          setResults(found);
          setError(found.length ? null : null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Search failed');
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 450);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [query, near]);

  const choose = (place: Place) => {
    saveRecent(place);
    onPick(place);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex h-[88vh] flex-col pb-safe" hideClose>
        <SheetHeader className="flex-row items-center justify-between space-y-0">
          <SheetTitle>{title}</SheetTitle>
          <Button variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>

        <div className="px-5 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a place or address"
              className="pl-9 pr-9"
              autoComplete="off"
              enterKeyHint="search"
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>

          <div className="mt-3 flex gap-2">
            {onUseCurrentLocation && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={async () => {
                  await onUseCurrentLocation();
                  onOpenChange(false);
                }}
              >
                <Crosshair className="h-4 w-4" />
                Current location
              </Button>
            )}
            {onPickOnMap && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => {
                  onPickOnMap();
                  onOpenChange(false);
                }}
              >
                <MapPin className="h-4 w-4" />
                Pick on map
              </Button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}

          {!query && recents.length > 0 && (
            <>
              <p className="pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Recent
              </p>
              <PlaceRows
                rows={recents.map((p, i) => ({
                  id: `recent-${i}`,
                  primary: p.address.split(',')[0],
                  secondary: p.address.split(',').slice(1, 4).join(', '),
                  place: p,
                }))}
                onPick={choose}
              />
            </>
          )}

          {results.length > 0 && (
            <PlaceRows
              rows={results.map((r) => ({
                id: r.id,
                primary: r.primary,
                secondary: r.secondary,
                place: { lat: r.lat, lng: r.lng, address: r.address },
              }))}
              onPick={choose}
            />
          )}

          {!searching && query.trim().length >= 3 && !results.length && !error && (
            <EmptyState
              icon={Search}
              title="No places found"
              description="Try a different spelling, or drop a pin on the map."
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PlaceRows({
  rows,
  onPick,
}: {
  rows: { id: string; primary: string; secondary: string; place: Place }[];
  onPick: (place: Place) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            onClick={() => onPick(row.place)}
            className="flex w-full items-start gap-3 py-3 text-left transition hover:opacity-70"
          >
            <div className="mt-0.5 rounded-lg bg-secondary p-2">
              <MapPin className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{row.primary}</p>
              {row.secondary && (
                <p className="truncate text-xs text-muted-foreground">{row.secondary}</p>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Centre-pin selection mode, used by "Pick on map". */
export function MapPinConfirm({
  center,
  label,
  onConfirm,
  onCancel,
}: {
  center: LatLng | null;
  label: string;
  onConfirm: (place: Place) => void;
  onCancel: () => void;
}) {
  const [address, setAddress] = React.useState<string | null>(null);
  const [resolving, setResolving] = React.useState(false);

  React.useEffect(() => {
    if (!center) return;
    let cancelled = false;
    setResolving(true);

    const timer = setTimeout(async () => {
      const resolved = await reverseGeocode(center);
      if (!cancelled) {
        setAddress(resolved);
        setResolving(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [center]);

  return (
    <>
      {/* Fixed crosshair: the map moves under it. */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-full">
        <div className="flex flex-col items-center">
          <div className="rounded-full bg-primary p-2 shadow-lg">
            <MapPin className="h-5 w-5 text-primary-foreground" />
          </div>
          <div className="h-3 w-0.5 bg-primary" />
          <div className="h-1.5 w-1.5 rounded-full bg-primary" />
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-30 p-3 pb-safe">
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sheet">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={cn('mt-1.5 min-h-10 text-sm', resolving && 'text-muted-foreground')}>
            {resolving ? 'Finding this place…' : (address ?? 'Move the map to choose')}
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!center || resolving}
              onClick={() => center && onConfirm({ ...center, address: address ?? '' })}
            >
              Confirm
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
