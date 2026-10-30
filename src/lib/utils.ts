import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { env } from './env';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 1240 -> "1.2 km", 640 -> "640 m" */
export function formatDistance(metres: number | null | undefined): string {
  if (metres == null || !Number.isFinite(metres)) return '--';
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}

/** 95 -> "2 min", 4500 -> "1 h 15 min" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--';
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatMoney(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '--';
  return `${env.currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/**
 * Local fare preview so the customer sees a number before the booking exists.
 * The authoritative fare is computed by create_booking() from admin_settings.
 */
export function estimateFare(distanceM: number | null, durationS: number | null): number | null {
  if (distanceM == null && durationS == null) return null;
  return Math.round(
    env.fare.base +
      env.fare.perKm * ((distanceM ?? 0) / 1000) +
      env.fare.perMin * ((durationS ?? 0) / 60),
  );
}

/** Seconds until an ISO timestamp, never negative. */
export function secondsUntil(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

export function secondsSince(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function truncate(text: string, max = 48): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Stable key for create_booking idempotency across retries of one intent. */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
