import { Clock, MapPin, Navigation2, Route as RouteIcon } from 'lucide-react';
import { cn, formatDistance, formatDuration } from '@/lib/utils';

/**
 * The journey, start to end, as one readable strip.
 *
 * A vertical rail connects an origin dot to a destination square, with the
 * distance and duration shown on the connector itself. Putting the numbers
 * *between* the two points is what makes it read as a journey rather than as
 * two unrelated addresses with some statistics underneath.
 */
export function RouteVisual({
  pickup,
  destination,
  distanceM,
  durationS,
  /** Marks the leg as not yet travelled (dashed rail). */
  pending = false,
  onPickupClick,
  onDestinationClick,
  className,
}: {
  pickup: string | null;
  destination: string | null;
  distanceM?: number | null;
  durationS?: number | null;
  pending?: boolean;
  onPickupClick?: () => void;
  onDestinationClick?: () => void;
  className?: string;
}) {
  const hasMetrics = distanceM != null || durationS != null;

  return (
    <div className={cn('flex gap-3', className)}>
      {/* The rail */}
      <div className="flex w-5 shrink-0 flex-col items-center pt-1.5">
        <span className="relative flex h-3 w-3 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-success/25" />
          <span className="relative h-2 w-2 rounded-full bg-success" />
        </span>

        <span
          className={cn(
            'my-1 w-0.5 flex-1',
            pending
              ? 'bg-[repeating-linear-gradient(to_bottom,hsl(var(--muted-foreground)/0.45)_0_4px,transparent_4px_9px)]'
              : 'bg-gradient-to-b from-success via-primary to-foreground',
          )}
          style={{ minHeight: hasMetrics ? 44 : 22 }}
          aria-hidden
        />

        <span className="h-3 w-3 rotate-45 rounded-[3px] bg-foreground" />
      </div>

      {/* The two ends, with the metrics wedged between them */}
      <div className="min-w-0 flex-1">
        <Stop
          label="From"
          icon={MapPin}
          value={pickup}
          onClick={onPickupClick}
        />

        {hasMetrics && (
          <div className="flex items-center gap-2 py-2 pl-0.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1">
              <RouteIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="tabular text-xs font-semibold">{formatDistance(distanceM)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="tabular text-xs font-semibold">{formatDuration(durationS)}</span>
            </span>
          </div>
        )}

        {!hasMetrics && <div className="h-2" />}

        <Stop
          label="To"
          icon={Navigation2}
          value={destination}
          onClick={onDestinationClick}
        />
      </div>
    </div>
  );
}

function Stop({
  label,
  icon: Icon,
  value,
  onClick,
}: {
  label: string;
  icon: typeof MapPin;
  value: string | null;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'flex items-center gap-1.5 text-sm leading-snug',
          !value && 'text-muted-foreground',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{value || 'Tap to choose'}</span>
        {onClick && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </span>
    </>
  );

  if (!onClick) return <div className="min-w-0">{content}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full min-w-0 rounded-lg px-1 py-0.5 -mx-1 text-left transition hover:bg-secondary/60"
    >
      {content}
    </button>
  );
}
