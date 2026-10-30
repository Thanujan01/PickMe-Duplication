import { supabase, toAppError, unwrap } from '@/lib/supabase';
import type { Profile, UserRole } from '@/types/database';

export interface SignUpInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  /** Only 'customer' or 'rider'; the database refuses anything else. */
  role: Extract<UserRole, 'customer' | 'rider'>;
}

export async function signUp(input: SignUpInput) {
  const { data, error } = await supabase.auth.signUp({
    email: input.email.trim().toLowerCase(),
    password: input.password,
    options: {
      // handle_new_user() reads these to build the profile row.
      data: {
        full_name: input.fullName.trim(),
        phone: input.phone?.trim() || null,
        role: input.role,
      },
    },
  });
  if (error) throw toAppError(error);
  return data;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
  if (error) throw toAppError(error);
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw toAppError(error);
}

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw toAppError(error);
  return data as Profile | null;
}

export async function updateProfile(
  userId: string,
  patch: Partial<Pick<Profile, 'full_name' | 'phone' | 'avatar_url'>>,
) {
  return unwrap(
    await supabase.from('profiles').update(patch).eq('id', userId).select('*').single(),
  ) as Profile;
}

export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  if (error) throw toAppError(error);
}

export async function updatePassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw toAppError(error);
}

/** Landing route for a role. Keeps redirect logic in one place. */
export function homeForRole(role: UserRole | undefined): string {
  switch (role) {
    case 'rider':
      return '/rider';
    case 'admin':
      return '/admin';
    case 'customer':
      return '/';
    default:
      return '/login';
  }
}
