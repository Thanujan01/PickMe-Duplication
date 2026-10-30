import * as React from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Profile, UserRole } from '@/types/database';
import { fetchProfile } from './api';

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  role: UserRole | undefined;
  /** True until the initial session + profile lookup settles. */
  loading: boolean;
  /** Set when the profile row could not be read (e.g. RLS or network). */
  error: string | null;
  refreshProfile: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const userId = session?.user?.id ?? null;

  const loadProfile = React.useCallback(async (id: string) => {
    try {
      const p = await fetchProfile(id);
      setProfile(p);
      // The profile is created by a database trigger. On the very first login
      // after signup there is a small window where it does not exist yet.
      if (!p) {
        setError('profile_pending');
      } else {
        setError(null);
      }
    } catch (e) {
      setProfile(null);
      setError(e instanceof Error ? e.message : 'Could not load your profile.');
    }
  }, []);

  // Initial session, then keep in step with auth events.
  React.useEffect(() => {
    let active = true;

    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (!active) return;
        setSession(data.session);
        if (data.session?.user) await loadProfile(data.session.user.id);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return;
      setSession(next);

      if (!next?.user) {
        setProfile(null);
        setError(null);
        return;
      }
      // TOKEN_REFRESHED fires often and carries no new profile information.
      if (event !== 'TOKEN_REFRESHED') {
        void loadProfile(next.user.id);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  // Retry a pending profile a few times rather than stranding a new signup.
  React.useEffect(() => {
    if (!userId || error !== 'profile_pending') return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > 5) {
        clearInterval(timer);
        setError('Your profile could not be created. Please contact support.');
        return;
      }
      void loadProfile(userId);
    }, 1200);
    return () => clearInterval(timer);
  }, [userId, error, loadProfile]);

  const refreshProfile = React.useCallback(async () => {
    if (userId) await loadProfile(userId);
  }, [userId, loadProfile]);

  const value = React.useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      role: profile?.role,
      loading,
      error: error === 'profile_pending' ? null : error,
      refreshProfile,
    }),
    [session, profile, loading, error, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
