import * as React from 'react';
import { Info, Save, Search, Users } from 'lucide-react';
import { AppShell } from '@/components/shared/AppShell';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SkeletonList } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAllSettings } from '@/features/settings/hooks';
import { useAdminCustomers, useSetSetting } from '@/features/admin/hooks';

/** Settings written here feed straight into the dispatch functions. */
export default function AdminSettings() {
  return (
    <AppShell title="Settings">
      <div className="mx-auto max-w-2xl p-4">
        <Tabs defaultValue="dispatch">
          <TabsList className="w-full">
            <TabsTrigger value="dispatch" className="flex-1">
              Platform
            </TabsTrigger>
            <TabsTrigger value="customers" className="flex-1">
              Customers
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dispatch">
            <SettingsForm />
          </TabsContent>

          <TabsContent value="customers">
            <CustomerList />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

function SettingsForm() {
  const { data, isLoading } = useAllSettings();
  const save = useSetSetting();
  const [draft, setDraft] = React.useState<Record<string, string>>({});

  if (isLoading) return <SkeletonList rows={5} />;

  const booleans = (data ?? []).filter((s) => typeof s.value === 'boolean');
  const numbers = (data ?? []).filter((s) => typeof s.value === 'number');
  const others = (data ?? []).filter(
    (s) => typeof s.value !== 'boolean' && typeof s.value !== 'number',
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-xl border border-border bg-secondary/50 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          These values are read by the SQL dispatch functions on every call, so changes take effect
          on the next booking - no redeploy needed.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Dispatch & pricing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {numbers.map((setting) => {
            const current = draft[setting.key] ?? String(setting.value);
            const dirty = current !== String(setting.value);

            return (
              <div key={setting.key} className="space-y-1.5">
                <Label htmlFor={setting.key}>{setting.label || setting.key}</Label>
                <div className="flex gap-2">
                  <Input
                    id={setting.key}
                    type="number"
                    inputMode="numeric"
                    value={current}
                    onChange={(e) => setDraft((d) => ({ ...d, [setting.key]: e.target.value }))}
                  />
                  <Button
                    size="icon"
                    variant={dirty ? 'default' : 'outline'}
                    disabled={!dirty}
                    loading={save.isPending && save.variables?.key === setting.key}
                    aria-label={`Save ${setting.key}`}
                    onClick={() => {
                      const parsed = Number(current);
                      if (!Number.isFinite(parsed)) return;
                      save.mutate({ key: setting.key, value: parsed });
                      setDraft((d) => {
                        const next = { ...d };
                        delete next[setting.key];
                        return next;
                      });
                    }}
                  >
                    <Save className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  <code className="rounded bg-muted px-1">{setting.key}</code>
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {!!booleans.length && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Policies</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {booleans.map((setting) => (
              <div key={setting.key} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{setting.label || setting.key}</p>
                  <code className="text-[11px] text-muted-foreground">{setting.key}</code>
                </div>
                <Switch
                  checked={setting.value === true}
                  disabled={save.isPending}
                  onCheckedChange={(next) => save.mutate({ key: setting.key, value: next })}
                  aria-label={setting.label || setting.key}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!!others.length && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Other</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {others.map((setting) => (
              <div key={setting.key} className="flex items-center justify-between gap-2 text-sm">
                <code className="text-xs">{setting.key}</code>
                <Badge variant="secondary" className="max-w-[55%] truncate">
                  {JSON.stringify(setting.value)}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CustomerList() {
  const [input, setInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const { data, isLoading } = useAdminCustomers(search);

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(input), 400);
    return () => clearTimeout(t);
  }, [input]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search customers by name or phone"
          className="pl-9"
        />
      </div>

      {isLoading && <SkeletonList rows={4} />}

      {!isLoading && !data?.length && (
        <EmptyState icon={Users} title="No customers found" />
      )}

      {!!data?.length && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {data.map((customer) => (
            <li key={customer.id} className="flex items-center gap-3 p-3.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{customer.full_name || 'Unnamed'}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {customer.phone || 'no phone'}
                </p>
              </div>
              {customer.is_blocked && <Badge variant="destructive">Blocked</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
