import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Bus, Car, Pencil, Plus, Search, Star, UserCheck, UserX } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AppShell } from '@/components/shared/AppShell';
import { AvailabilityBadge } from '@/components/shared/StatusBadge';
import { EmptyState } from '@/components/shared/states';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SkeletonList } from '@/components/ui/skeleton';
import { initials, secondsSince } from '@/lib/utils';
import { useAdminRiders, useSetRiderActive, useUpsertRiderDetails } from '@/features/admin/hooks';
import { usePublicSettings } from '@/features/settings/hooks';
import type { RiderWithProfile } from '@/types/database';

const schema = z.object({
  fullName: z.string().trim().min(2, 'Enter the rider name'),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9 ()-]{6,24}$/, 'Enter a valid phone number')
    .or(z.literal('')),
  licenseNumber: z.string().trim().max(40).optional(),
  make: z.string().trim().max(40).optional(),
  model: z.string().trim().max(40).optional(),
  color: z.string().trim().max(24).optional(),
  plateNumber: z.string().trim().min(2, 'Plate number is required'),
  // Kept as a string: a number input yields '' when cleared, and z.coerce would
  // turn that into 0 and fail the range check with a misleading message.
  year: z
    .string()
    .trim()
    .refine((v) => v === '' || (/^\d{4}$/.test(v) && Number(v) >= 1950 && Number(v) <= 2100), {
      message: 'Enter a year between 1950 and 2100',
    }),
});

type Values = z.infer<typeof schema>;

export default function AdminRiders() {
  const { data: riders, isLoading } = useAdminRiders();
  const { data: settings } = usePublicSettings();
  const setActive = useSetRiderActive();
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<RiderWithProfile | null>(null);
  const [showAdd, setShowAdd] = React.useState(false);

  const staleSeconds = settings?.gpsStaleSeconds ?? 45;

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return riders ?? [];
    return (riders ?? []).filter(
      (r) =>
        r.profile?.full_name.toLowerCase().includes(term) ||
        r.profile?.phone?.toLowerCase().includes(term) ||
        r.vehicles.some((v) => v.plate_number.toLowerCase().includes(term)),
    );
  }, [riders, search]);

  return (
    <AppShell
      title="Riders"
      actions={
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4" />
          Add
        </Button>
      }
    >
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, phone or plate"
            className="pl-9"
          />
        </div>

        {isLoading && <SkeletonList rows={4} />}

        {!isLoading && !filtered.length && (
          <EmptyState
            icon={Car}
            title={search ? 'No riders match' : 'No riders yet'}
            description={
              search
                ? 'Try a different search term.'
                : 'Riders sign up through the app, then you add their vehicle here.'
            }
          />
        )}

        {filtered.map((rider) => {
          const stale =
            rider.availability === 'online' &&
            secondsSince(rider.location?.last_seen) > staleSeconds;
          const vehicle = rider.vehicles.find((v) => v.is_primary) ?? rider.vehicles[0];

          return (
            <div
              key={rider.id}
              className="rounded-xl border border-border bg-card p-4 shadow-card"
            >
              <div className="flex items-start gap-3">
                <Avatar>
                  {rider.profile?.avatar_url && <AvatarImage src={rider.profile.avatar_url} alt="" />}
                  <AvatarFallback>{initials(rider.profile?.full_name)}</AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-semibold">
                      {rider.profile?.full_name || 'Unnamed rider'}
                    </p>
                    <AvailabilityBadge availability={rider.availability} stale={stale} />
                    {!rider.is_active && <Badge variant="destructive">Deactivated</Badge>}
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {rider.profile?.phone && <span>{rider.profile.phone}</span>}
                    <span className="flex items-center gap-1">
                      <Star className="h-3 w-3 fill-warning text-warning" />
                      <span className="tabular">{Number(rider.rating).toFixed(1)}</span>
                    </span>
                    <span className="tabular">{rider.total_rides} rides</span>
                    {rider.location?.last_seen && (
                      <span>
                        seen{' '}
                        {formatDistanceToNow(new Date(rider.location.last_seen), {
                          addSuffix: true,
                        })}
                      </span>
                    )}
                  </div>

                  {vehicle ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="font-mono tracking-wider">
                        {vehicle.plate_number}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {[vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(' ') ||
                          vehicle.vehicle_type}
                      </span>
                      <Badge variant="secondary" className="capitalize">
                        {vehicle.vehicle_type}
                      </Badge>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-warning">
                      No vehicle registered - this rider will not be matched.
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditing(rider)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button
                  variant={rider.is_active ? 'ghost' : 'secondary'}
                  size="sm"
                  className={rider.is_active ? 'flex-1 text-destructive hover:bg-destructive/10' : 'flex-1'}
                  loading={setActive.isPending}
                  onClick={() => setActive.mutate({ riderId: rider.id, active: !rider.is_active })}
                >
                  {rider.is_active ? (
                    <>
                      <UserX className="h-3.5 w-3.5" />
                      Deactivate
                    </>
                  ) : (
                    <>
                      <UserCheck className="h-3.5 w-3.5" />
                      Activate
                    </>
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <RiderDialog rider={editing} onClose={() => setEditing(null)} />
      <AddRiderDialog open={showAdd} onOpenChange={setShowAdd} />
    </AppShell>
  );
}

function RiderDialog({
  rider,
  onClose,
}: {
  rider: RiderWithProfile | null;
  onClose: () => void;
}) {
  const save = useUpsertRiderDetails();
  const vehicle = rider?.vehicles.find((v) => v.is_primary) ?? rider?.vehicles[0];

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    values: {
      fullName: rider?.profile?.full_name ?? '',
      phone: rider?.profile?.phone ?? '',
      licenseNumber: rider?.license_number ?? '',
      make: vehicle?.make ?? '',
      model: vehicle?.model ?? '',
      color: vehicle?.color ?? '',
      plateNumber: vehicle?.plate_number ?? '',
      year: vehicle?.year != null ? String(vehicle.year) : '',
    },
  });

  const submit = async (values: Values) => {
    if (!rider) return;
    await save.mutateAsync({
      riderId: rider.id,
      fullName: values.fullName,
      phone: values.phone || undefined,
      licenseNumber: values.licenseNumber || undefined,
      vehicleType: 'bus',
      make: values.make,
      model: values.model,
      color: values.color,
      plateNumber: values.plateNumber,
      year: values.year ? Number(values.year) : null,  // '' -> null
    });
    onClose();
  };

  return (
    <Dialog open={!!rider} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Rider details</DialogTitle>
          <DialogDescription>
            Vehicle class decides which bookings this rider is matched to.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(submit)} className="space-y-3" noValidate>
          <Field label="Full name" error={form.formState.errors.fullName?.message}>
            <Input {...form.register('fullName')} />
          </Field>
          <Field label="Phone" error={form.formState.errors.phone?.message}>
            <Input type="tel" {...form.register('phone')} />
          </Field>
          <Field label="Licence number" error={form.formState.errors.licenseNumber?.message}>
            <Input {...form.register('licenseNumber')} />
          </Field>

          <div className="rounded-xl bg-secondary/60 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Vehicle
            </p>
            <div className="space-y-3">
              <Field label="Type">
                <div className="flex h-11 items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 text-sm">
                  <Bus className="h-4 w-4 text-muted-foreground" />
                  Bus
                  <span className="ml-auto text-xs text-muted-foreground">only class</span>
                </div>
              </Field>
              <Field label="Plate number" error={form.formState.errors.plateNumber?.message}>
                <Input className="font-mono" {...form.register('plateNumber')} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Make">
                  <Input {...form.register('make')} />
                </Field>
                <Field label="Model">
                  <Input {...form.register('model')} />
                </Field>
                <Field label="Colour">
                  <Input {...form.register('color')} />
                </Field>
                <Field label="Year" error={form.formState.errors.year?.message}>
                  <Input type="number" inputMode="numeric" {...form.register('year')} />
                </Field>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save rider
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Creating an auth account needs the service-role key, which must never reach
 * the browser. So this explains the supported path rather than pretending to
 * do it client-side (spec section 15).
 */
function AddRiderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a rider</DialogTitle>
          <DialogDescription>Two supported ways, both safe.</DialogDescription>
        </DialogHeader>

        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            <span className="font-medium">Self-signup (recommended).</span> The rider registers at{' '}
            <code className="rounded bg-muted px-1 text-xs">/register</code> and picks "I drive".
            They appear in this list immediately; you then add their vehicle with{' '}
            <span className="font-medium">Edit</span>.
          </li>
          <li>
            <span className="font-medium">Create for them.</span> Deploy the{' '}
            <code className="rounded bg-muted px-1 text-xs">admin-create-rider</code> Edge Function
            and call it with your admin session. It holds the service-role key server-side.
            Instructions are in <code className="rounded bg-muted px-1 text-xs">README.md</code>.
          </li>
        </ol>

        <p className="rounded-lg bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
          The browser deliberately has no way to create accounts: that would require shipping the
          service-role key to every visitor.
        </p>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
