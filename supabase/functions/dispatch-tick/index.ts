/**
 * dispatch-tick
 *
 * HTTP entry point for the dispatch clock. The *primary* scheduler is pg_cron
 * (migration 0006), which runs `select public.dispatch_tick()` every 5 seconds
 * inside the database. This function exists for two cases:
 *
 *   1. A project where pg_cron cannot be enabled. Point an external scheduler
 *      at this URL every 5-10 seconds instead (GitHub Actions, cron-job.org,
 *      Upstash QStash, ...).
 *   2. Manual nudges while debugging.
 *
 * Calling it more often than needed is harmless: dispatch_tick() only reaps
 * deadlines already recorded in booking_dispatches.expires_at, and every
 * decision re-checks state under a row lock.
 *
 * Deploy:
 *   supabase functions deploy dispatch-tick --no-verify-jwt
 *   supabase secrets set DISPATCH_TICK_SECRET="$(openssl rand -hex 32)"
 *
 * Call:
 *   curl -X POST "$URL/functions/v1/dispatch-tick" -H "x-dispatch-secret: <secret>"
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SHARED_SECRET = Deno.env.get('DISPATCH_TICK_SECRET') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Constant-time comparison so the secret cannot be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Deployed with --no-verify-jwt so an external cron can reach it, which makes
  // this shared secret the only gate. Refuse to run without one configured.
  if (!SHARED_SECRET) {
    return json(
      {
        error: 'not_configured',
        hint: 'Set DISPATCH_TICK_SECRET: supabase secrets set DISPATCH_TICK_SECRET="$(openssl rand -hex 32)"',
      },
      503,
    );
  }

  const provided = req.headers.get('x-dispatch-secret') ?? '';
  if (!safeEqual(provided, SHARED_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.rpc('dispatch_tick');

  if (error) {
    console.error('[dispatch-tick]', error);
    return json({ error: error.message }, 500);
  }

  return json({ ok: true, result: data });
});
