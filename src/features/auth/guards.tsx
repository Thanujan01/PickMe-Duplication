import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UserRole } from '@/types/database';
import { useAuth } from './AuthProvider';
import { homeForRole, signOut } from './api';

function FullPageSpinner({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

/**
 * Route protection is a convenience for the person using the app, not a
 * security boundary - that lives in RLS (see supabase/migrations/0005_rls.sql).
 */
export function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner label="Signing you in" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function RequireRole({ allow }: { allow: UserRole[] }) {
  const { session, profile, role, loading, error } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner label="Loading your account" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <ShieldAlert className="h-10 w-10 text-destructive" />
        <div>
          <p className="font-semibold">We could not load your account</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out and try again
        </Button>
      </div>
    );
  }

  if (!profile) return <FullPageSpinner label="Preparing your account" />;

  if (profile.is_blocked) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <ShieldAlert className="h-10 w-10 text-destructive" />
        <div>
          <p className="font-semibold">Account suspended</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            This account cannot be used right now. Please contact support.
          </p>
        </div>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  if (!role || !allow.includes(role)) {
    return <Navigate to={homeForRole(role)} replace />;
  }

  return <Outlet />;
}

/** Sends an already-signed-in person away from /login and /register. */
export function RedirectIfAuthed() {
  const { session, role, loading } = useAuth();
  if (loading) return <FullPageSpinner label="Checking your session" />;
  if (session) return <Navigate to={homeForRole(role)} replace />;
  return <Outlet />;
}
