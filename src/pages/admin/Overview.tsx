import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Car,
  CheckCircle2,
  Clock,
  Satellite,
  Users,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AppShell } from '@/components/shared/AppShell';
import { ErrorState } from '@/components/shared/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAdminStats } from '@/features/admin/hooks';

export default function AdminOverview() {
  const { data, isLoading, isError, error, refetch } = useAdminStats();

  if (isError) {
    return (
      <AppShell title="Overview">
        <ErrorState
          title="Could not load statistics"
          description={(error as Error)?.message}
          onRetry={() => void refetch()}
        />
      </AppShell>
    );
  }

  return (
    <AppShell title="Overview">
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        {/* Fleet */}
        <section>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Fleet
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              icon={Activity}
              label="Online"
              value={data?.riders_online}
              loading={isLoading}
              tone="success"
            />
            <Tile icon={Car} label="On a ride" value={data?.riders_busy} loading={isLoading} tone="warning" />
            <Tile icon={XCircle} label="Offline" value={data?.riders_offline} loading={isLoading} />
            <Tile
              icon={Satellite}
              label="GPS stale"
              value={data?.riders_stale}
              loading={isLoading}
              tone={data?.riders_stale ? 'destructive' : undefined}
            />
          </div>
          {!!data?.riders_stale && (
            <div className="mt-2 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-xs text-muted-foreground">
                {data.riders_stale} rider{data.riders_stale === 1 ? '' : 's'} marked online but not
                reporting a position. They are skipped by dispatch until their GPS resumes - usually
                a locked phone screen.
              </p>
            </div>
          )}
        </section>

        {/* Bookings */}
        <section>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Bookings
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              icon={Clock}
              label="Active now"
              value={data?.bookings_active}
              loading={isLoading}
              tone={data?.bookings_active ? 'success' : undefined}
            />
            <Tile icon={Activity} label="Today" value={data?.bookings_today} loading={isLoading} />
            <Tile
              icon={CheckCircle2}
              label="Completed"
              value={data?.bookings_completed}
              loading={isLoading}
            />
            <Tile
              icon={XCircle}
              label="Unfulfilled"
              value={data?.bookings_failed}
              loading={isLoading}
              tone={data?.bookings_failed ? 'destructive' : undefined}
            />
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Platform</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Customers" value={data?.customers} loading={isLoading} icon={Users} />
              <Row label="Riders" value={data?.riders} loading={isLoading} icon={Car} />
              <Row
                label="Total bookings"
                value={data?.bookings_total}
                loading={isLoading}
                icon={Clock}
              />
              <Row
                label="Cancelled"
                value={data?.bookings_cancelled}
                loading={isLoading}
                icon={XCircle}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Operations</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Dispatch contacts the nearest eligible bus first, then the next, every
                10 seconds until one accepts.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  to="/admin/bookings"
                  className="rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold transition hover:bg-secondary/70"
                >
                  Manage bookings
                </Link>
                <Link
                  to="/admin/fleet"
                  className="rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold transition hover:bg-secondary/70"
                >
                  Live map
                </Link>
                <Link
                  to="/admin/settings"
                  className="rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold transition hover:bg-secondary/70"
                >
                  Settings
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  loading,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number | undefined;
  loading: boolean;
  tone?: 'success' | 'warning' | 'destructive';
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5 shadow-card">
      <div className="flex items-center justify-between">
        <Icon
          className={cn(
            'h-4 w-4',
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
            tone === 'destructive' && 'text-destructive',
            !tone && 'text-muted-foreground',
          )}
        />
        {tone === 'success' && !!value && (
          <Badge variant="success" className="px-1.5 py-0 text-[10px]">
            live
          </Badge>
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-12" />
      ) : (
        <p className="tabular mt-1.5 text-2xl font-bold leading-none">{value ?? 0}</p>
      )}
      <p className="mt-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function Row({
  label,
  value,
  loading,
  icon: Icon,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  icon: LucideIcon;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      {loading ? <Skeleton className="h-4 w-8" /> : <span className="tabular font-semibold">{value ?? 0}</span>}
    </div>
  );
}
