/**
 * admin-create-rider
 *
 * Lets an administrator create a rider account outright, instead of waiting
 * for the rider to self-register.
 *
 * Creating an auth user requires the service-role key. That key must never be
 * shipped to a browser, which is exactly why this lives in an Edge Function:
 * the browser sends its own session, this function verifies the caller really
 * is an admin, and only then uses the privileged key.
 *
 * Deploy:
 *   supabase functions deploy admin-create-rider
 *   (keep JWT verification ON - the caller must be signed in)
 *
 * Call from the admin dashboard:
 *   const { data: { session } } = await supabase.auth.getSession();
 *   await fetch(`${SUPABASE_URL}/functions/v1/admin-create-rider`, {
 *     method: 'POST',
 *     headers: {
 *       Authorization: `Bearer ${session.access_token}`,
 *       'Content-Type': 'application/json',
 *     },
 *     body: JSON.stringify({
 *       email: 'rider1@example.com',
 *       password: 'temporary-password',
 *       full_name: 'Nuwan Silva',
 *       phone: '+94771234567',
 *       plate_number: 'CAB-1234',
 *       vehicle_type: 'car',
 *     }),
 *   });
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

interface Body {
  email?: string;
  password?: string;
  full_name?: string;
  phone?: string;
  license_number?: string;
  vehicle_type?: 'car' | 'bike' | 'tuk' | 'van';
  make?: string;
  model?: string;
  color?: string;
  plate_number?: string;
  year?: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'missing_authorization' }, 401);

  // Step 1: identify the caller using THEIR token, with anon privileges.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user: caller },
    error: callerError,
  } = await asCaller.auth.getUser();

  if (callerError || !caller) return json({ error: 'invalid_session' }, 401);

  // Step 2: confirm the caller is an admin. Checked against the database, not
  // against anything the client sent.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', caller.id)
    .maybeSingle();

  if (profile?.role !== 'admin') return json({ error: 'not_authorized' }, 403);

  // Step 3: validate input.
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  const fullName = body.full_name?.trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'invalid_email' }, 400);
  }
  if (!password || password.length < 8) {
    return json({ error: 'password_too_short' }, 400);
  }
  if (!fullName || fullName.length < 2) {
    return json({ error: 'full_name_required' }, 400);
  }
  // public.profiles enforces this same shape with a CHECK constraint; validate
  // here so a bad value fails with a clear message instead of a constraint
  // violation inside the handle_new_user trigger.
  const phone = body.phone?.trim() || null;
  if (phone && !/^[+0-9 ()-]{6,24}$/.test(phone)) {
    return json({ error: 'invalid_phone' }, 400);
  }

  // Step 4: create the auth user. The handle_new_user trigger creates the
  // profile and riders rows from this metadata.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      phone,
      role: 'rider',
    },
  });

  if (createError || !created.user) {
    return json({ error: createError?.message ?? 'create_failed' }, 400);
  }

  const riderId = created.user.id;

  // Step 5: fill in rider + vehicle details. Uses the same RPC the dashboard
  // uses, so validation lives in exactly one place.
  const { error: detailsError } = await admin.rpc('admin_upsert_rider_details', {
    p_rider_id: riderId,
    p_full_name: fullName,
    p_phone: phone,
    p_license_number: body.license_number ?? null,
    p_vehicle_type: body.vehicle_type ?? 'car',
    p_make: body.make ?? null,
    p_model: body.model ?? null,
    p_color: body.color ?? null,
    p_plate_number: body.plate_number ?? null,
    p_year: body.year ?? null,
  });

  if (detailsError) {
    // The account exists; report the partial outcome rather than pretending.
    return json(
      {
        rider_id: riderId,
        warning: 'account_created_but_details_failed',
        detail: detailsError.message,
      },
      207,
    );
  }

  return json({ rider_id: riderId, email }, 201);
});
