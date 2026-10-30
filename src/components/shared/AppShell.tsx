import * as React from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Bell,
  Car,
  ChevronLeft,
  Clock,
  LayoutDashboard,
  LogOut,
  MapPin,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { signOut } from '@/features/auth/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { useMarkNotificationsRead, useNotifications } from '@/features/notifications/hooks';
import { InstallPrompt } from './InstallPrompt';
import { NotificationList } from './NotificationList';

interface NavItem {
  to: string;
  label: string;
  icon: typeof MapPin;
  end?: boolean;
}

const NAV: Record<string, NavItem[]> = {
  customer: [
    { to: '/', label: 'Book', icon: MapPin, end: true },
    { to: '/history', label: 'Trips', icon: Clock },
  ],
  rider: [
    { to: '/rider', label: 'Drive', icon: Car, end: true },
    { to: '/rider/history', label: 'Rides', icon: Clock },
  ],
  admin: [
    { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/admin/riders', label: 'Riders', icon: Users },
    { to: '/admin/bookings', label: 'Bookings', icon: Clock },
    { to: '/admin/fleet', label: 'Live map', icon: MapPin },
  ],
};

/**
 * Chrome shared by every signed-in screen.
 *
 * `fullBleed` is for map-first pages: the content fills the viewport under a
 * floating header, with the tab bar overlaid, which is what makes the customer
 * booking screen feel native.
 */
export function AppShell({
  children,
  title,
  fullBleed = false,
  back,
  actions,
}: {
  children: React.ReactNode;
  title?: string;
  fullBleed?: boolean;
  back?: string;
  actions?: React.ReactNode;
}) {
  const { profile, role } = useAuth();
  const location = useLocation();
  const [inboxOpen, setInboxOpen] = React.useState(false);
  const { data: notifications, unread } = useNotifications();
  const markRead = useMarkNotificationsRead();

  const nav = NAV[role ?? 'customer'] ?? NAV.customer;

  const openInbox = () => {
    setInboxOpen(true);
    if (unread > 0) markRead.mutate(undefined);
  };

  return (
    <div className={cn('flex min-h-screen flex-col bg-background', fullBleed && 'h-screen overflow-hidden')}>
      <header
        className={cn(
          'z-30 flex items-center gap-2 px-3 pt-safe',
          fullBleed
            ? 'pointer-events-none absolute inset-x-0 top-0'
            : 'sticky top-0 border-b border-border bg-background/90 pb-3 backdrop-blur',
        )}
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2',
            fullBleed && 'pointer-events-auto rounded-xl bg-card/95 px-2.5 py-2 shadow-card backdrop-blur',
          )}
        >
          {back ? (
            <Button variant="ghost" size="icon-sm" asChild aria-label="Back">
              <Link to={back}>
                <ChevronLeft className="h-5 w-5" />
              </Link>
            </Button>
          ) : (
            <div className="ml-1 rounded-lg bg-primary p-1.5">
              <Car className="h-4 w-4 text-primary-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">{title ?? 'Ride'}</p>
            {profile?.full_name && !back && (
              <p className="truncate text-xs text-muted-foreground">{profile.full_name}</p>
            )}
          </div>
        </div>

        <div className={cn('flex items-center gap-1', fullBleed && 'pointer-events-auto')}>
          {actions}
          <Button
            variant={fullBleed ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={openInbox}
            aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
            className={cn(fullBleed && 'bg-card/95 shadow-card backdrop-blur')}
          >
            <span className="relative">
              <Bell className="h-5 w-5" />
              {unread > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </span>
          </Button>
          <Button
            variant={fullBleed ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => void signOut()}
            aria-label="Sign out"
            className={cn(fullBleed && 'bg-card/95 shadow-card backdrop-blur')}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className={cn('flex-1', fullBleed ? 'relative min-h-0' : 'pb-24')}>{children}</main>

      {/* Bottom tab bar: thumb-reachable, the spec's mobile-first requirement. */}
      {nav.length > 1 && (
        <nav
          className={cn(
            'z-30 flex flex-col',
            fullBleed ? 'pointer-events-none absolute inset-x-0 bottom-0' : 'fixed inset-x-0 bottom-0',
          )}
        >
          <div className="pointer-events-auto">
            <InstallPrompt />
          </div>
          <div className="pointer-events-auto border-t border-border bg-background/95 pb-safe backdrop-blur">
            <div className="mx-auto flex max-w-lg items-stretch">
              {nav.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors',
                      isActive ? 'text-foreground' : 'text-muted-foreground',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon className={cn('h-5 w-5', isActive && 'stroke-[2.4]')} />
                      {label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        </nav>
      )}

      <Sheet open={inboxOpen} onOpenChange={setInboxOpen}>
        <SheetContent side="bottom" className="pb-safe">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              Notifications
              {unread > 0 && <Badge variant="secondary">{unread} new</Badge>}
            </SheetTitle>
          </SheetHeader>
          <div className="max-h-[60vh] overflow-y-auto px-5 pb-4">
            <NotificationList
              notifications={notifications ?? []}
              onNavigate={() => setInboxOpen(false)}
              currentPath={location.pathname}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
