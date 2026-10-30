import { formatDistanceToNow } from 'date-fns';
import {
  Bell,
  BellRing,
  CarTaxiFront,
  CheckCircle2,
  Flag,
  MapPin,
  Navigation,
  Search,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EmptyState } from './states';
import { cn } from '@/lib/utils';
import type { AppNotification, NotificationType } from '@/types/database';

const ICONS: Record<NotificationType, LucideIcon> = {
  booking_created: Search,
  ride_request: BellRing,
  request_expired: XCircle,
  rider_assigned: CarTaxiFront,
  rider_arriving: Navigation,
  rider_arrived: MapPin,
  trip_started: Flag,
  trip_completed: CheckCircle2,
  booking_cancelled: XCircle,
  no_rider_available: XCircle,
};

const TONE: Partial<Record<NotificationType, string>> = {
  booking_cancelled: 'bg-destructive/10 text-destructive',
  no_rider_available: 'bg-destructive/10 text-destructive',
  request_expired: 'bg-muted text-muted-foreground',
  trip_completed: 'bg-success/12 text-success',
  rider_arrived: 'bg-success/12 text-success',
  ride_request: 'bg-warning/15 text-warning',
};

export function NotificationList({
  notifications,
  onNavigate,
  currentPath,
}: {
  notifications: AppNotification[];
  onNavigate?: () => void;
  currentPath?: string;
}) {
  if (!notifications.length) {
    return (
      <EmptyState
        icon={Bell}
        title="No notifications yet"
        description="Ride updates will appear here."
      />
    );
  }

  return (
    <ul className="divide-y divide-border">
      {notifications.map((n) => {
        const Icon = ICONS[n.type] ?? Bell;
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={onNavigate}
              disabled={!onNavigate}
              className={cn(
                'flex w-full items-start gap-3 py-3 text-left transition',
                onNavigate && 'hover:opacity-80',
              )}
              aria-current={currentPath && n.booking_id && currentPath.includes(n.booking_id) ? 'true' : undefined}
            >
              <div className={cn('mt-0.5 rounded-lg p-2', TONE[n.type] ?? 'bg-secondary text-foreground')}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className={cn('truncate text-sm', !n.read_at ? 'font-semibold' : 'font-medium')}>
                    {n.title}
                  </p>
                  <time className="shrink-0 text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                  </time>
                </div>
                {n.body && <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>}
              </div>
              {!n.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
