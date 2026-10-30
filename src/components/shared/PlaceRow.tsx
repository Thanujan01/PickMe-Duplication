import { MapPin, Navigation2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Pickup / destination row shared by the booking composer and summaries. */
export function PlaceRow({
  kind,
  label,
  value,
  onClick,
  className,
}: {
  kind: 'pickup' | 'destination';
  label: string;
  value: string | null;
  onClick?: () => void;
  className?: string;
}) {
  const Icon = kind === 'pickup' ? MapPin : Navigation2;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition enabled:hover:bg-secondary/60',
        className,
      )}
    >
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          kind === 'pickup' ? 'bg-success/12 text-success' : 'bg-secondary',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className={cn('block truncate text-sm', !value && 'text-muted-foreground')}>
          {value || 'Tap to choose'}
        </span>
      </span>
    </button>
  );
}
