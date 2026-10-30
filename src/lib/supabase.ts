import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { configErrors, env } from './env';

/**
 * The one Supabase client for the whole app.
 *
 * When configuration is missing we still construct a client against a dummy
 * URL so that module-level imports do not throw; `App.tsx` renders the setup
 * screen before any query can run.
 */
export const supabase: SupabaseClient = createClient(
  configErrors.length ? 'http://localhost:54321' : env.supabaseUrl,
  configErrors.length ? 'missing-anon-key' : env.supabaseAnonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'ride-app-auth',
    },
    realtime: {
      params: { eventsPerSecond: 12 },
    },
    global: {
      headers: { 'x-application-name': 'ride-app' },
    },
  },
);

/**
 * Postgres errors arrive with our short code as `message`. Map them to copy a
 * person can act on; anything unmapped falls through to the raw message so
 * nothing is silently swallowed.
 */
const ERROR_COPY: Record<string, string> = {
  not_authenticated: 'Please sign in again.',
  not_authorized: 'You do not have permission to do that.',
  profile_missing: 'Your profile is still being set up. Try again in a moment.',
  account_blocked: 'This account has been suspended. Contact support.',
  not_a_customer: 'Only customer accounts can book rides.',
  not_a_rider: 'This action is only available to riders.',
  rider_deactivated: 'Your rider account is deactivated. Contact support.',
  invalid_coordinates: 'That location looks invalid. Try picking it again.',
  accuracy_too_low: 'Your GPS signal is too weak. Move to an open area.',
  active_booking_exists: 'You already have a ride in progress.',
  booking_not_found: 'That booking no longer exists.',
  booking_taken: 'Another rider accepted this ride first.',
  offer_expired: 'This request expired and moved to the next rider.',
  offer_not_pending: 'This request is no longer open.',
  no_offer_for_rider: 'This request was not sent to you.',
  no_pending_offer: 'There is no open request to respond to.',
  rider_busy: 'Finish your current ride before taking another.',
  has_active_booking: 'You cannot go offline during an active ride.',
  location_required: 'We need your location before you can go online.',
  busy_is_system_managed: 'Busy status is set automatically.',
  illegal_transition: 'That step is not valid right now.',
  not_assigned_rider: 'Only the assigned rider can do that.',
  booking_not_cancellable: 'This ride can no longer be cancelled.',
  trip_in_progress: 'The trip has already started. Contact support to cancel.',
  cancel_window_closed: 'Cancellation is no longer allowed for this ride.',
  booking_not_retryable: 'This booking cannot be retried.',
  booking_not_assignable: 'This booking can no longer be assigned.',
  rider_unavailable: 'That rider is not available.',
  rider_has_active_booking: 'That rider is on a ride right now.',
  role_change_forbidden: 'Roles can only be changed by an administrator.',
  block_change_forbidden: 'Only an administrator can change that.',
  invalid_token: 'Could not register this device for notifications.',
  use_rpc_to_change_rider_state: 'That field is managed by the platform.',
};

export interface AppError extends Error {
  code: string;
  detail?: string;
}

/** Normalise anything Supabase throws into a message worth showing. */
export function toAppError(error: unknown): AppError {
  const fallback = 'Something went wrong. Please try again.';

  if (error && typeof error === 'object') {
    const e = error as { message?: string; details?: string; hint?: string; code?: string };
    const rawMessage = (e.message ?? '').trim();
    const key = rawMessage.replace(/^.*\b(P0001|ERROR):\s*/i, '');
    const copy = ERROR_COPY[key];

    if (copy) {
      const err = new Error(copy) as AppError;
      err.code = key;
      if (e.details) err.detail = e.details;
      return err;
    }

    // Unique-violation on the "one live booking" indexes.
    if (e.code === '23505' || rawMessage.includes('bookings_one_live_per_customer')) {
      const err = new Error(ERROR_COPY.active_booking_exists) as AppError;
      err.code = 'active_booking_exists';
      return err;
    }

    if (rawMessage) {
      const err = new Error(rawMessage) as AppError;
      err.code = e.code ?? 'unknown';
      return err;
    }
  }

  const err = new Error(fallback) as AppError;
  err.code = 'unknown';
  return err;
}

/** Throw on error, otherwise return data. Keeps api modules terse. */
export function unwrap<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw toAppError(result.error);
  return result.data as T;
}
