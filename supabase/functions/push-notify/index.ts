/**
 * push-notify
 *
 * Optional Firebase Cloud Messaging relay (spec section 13).
 *
 * The app does NOT need this: notifications already reach an open tab over
 * Supabase Realtime and are raised through the service worker. This function
 * adds delivery to a *closed* app, which only a real push service can do.
 *
 * Flow:
 *   public.push_notification()  -- inserts the notifications row
 *     -> public.relay_push()    -- pg_net POST, only if `fcm_relay_url` is set
 *       -> this function        -- looks up the row + the user's device tokens
 *         -> FCM HTTP v1 API    -- one message per token
 *
 * Setup:
 *   1. Create a Firebase project and add a Web app.
 *   2. Project settings -> Service accounts -> Generate new private key.
 *   3. supabase secrets set FCM_SERVICE_ACCOUNT_JSON="$(cat service-account.json)"
 *      supabase secrets set PUSH_RELAY_SECRET="$(openssl rand -hex 32)"
 *   4. supabase functions deploy push-notify --no-verify-jwt
 *   5. In the SQL editor:
 *        select public.admin_set_setting('fcm_relay_url',
 *          '"https://<ref>.supabase.co/functions/v1/push-notify"'::jsonb);
 *        select public.admin_set_setting('fcm_relay_key', '"<PUSH_RELAY_SECRET>"'::jsonb);
 *
 * The service-account key never leaves the server.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERVICE_ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON') ?? '';
const RELAY_SECRET = Deno.env.get('PUSH_RELAY_SECRET') ?? '';

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

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

// --- Google OAuth: sign a JWT with the service-account key -------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

function base64url(bytes: Uint8Array | string): string {
  const raw =
    typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  return buffer.buffer;
}

async function getAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  );

  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: now + body.expires_in };
  return body.access_token;
}

// --- Handler -----------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (!SERVICE_ACCOUNT_JSON) {
    // Not an error: FCM is opt-in. Report so relay_push() stays quiet.
    return json({ skipped: 'fcm_not_configured' }, 200);
  }

  if (RELAY_SECRET) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${RELAY_SECRET}`) return json({ error: 'unauthorized' }, 401);
  }

  let payload: { notification_id?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!payload.notification_id) return json({ error: 'notification_id_required' }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: notification, error: readError } = await supabase
    .from('notifications')
    .select('*')
    .eq('id', payload.notification_id)
    .single();

  if (readError || !notification) return json({ error: 'notification_not_found' }, 404);

  const { data: tokens } = await supabase
    .from('device_tokens')
    .select('token')
    .eq('user_id', notification.user_id);

  if (!tokens?.length) return json({ sent: 0, reason: 'no_device_tokens' });

  let account: ServiceAccount;
  try {
    account = JSON.parse(SERVICE_ACCOUNT_JSON) as ServiceAccount;
  } catch {
    return json({ error: 'bad_service_account_json' }, 500);
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(account);
  } catch (e) {
    console.error('[push-notify] token', e);
    return json({ error: 'token_exchange_failed' }, 502);
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const isRideRequest = notification.type === 'ride_request';

  const results = await Promise.allSettled(
    tokens.map(async ({ token }) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: notification.title, body: notification.body },
            // Strings only: FCM rejects non-string data values.
            data: {
              type: String(notification.type),
              booking_id: String(notification.booking_id ?? ''),
              url: isRideRequest ? '/rider' : '/',
              tag: String(notification.booking_id ?? notification.id),
            },
            webpush: {
              headers: { Urgency: isRideRequest ? 'high' : 'normal', TTL: isRideRequest ? '30' : '600' },
              notification: {
                icon: '/icons/icon-192.png',
                badge: '/icons/badge-72.png',
                requireInteraction: isRideRequest,
              },
              fcm_options: { link: isRideRequest ? '/rider' : '/' },
            },
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        // A dead registration should not be retried forever.
        if (res.status === 404 || res.status === 400) {
          await supabase.from('device_tokens').delete().eq('token', token);
        }
        throw new Error(`${res.status} ${text}`);
      }
      return true;
    }),
  );

  const sent = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - sent;
  if (failed) {
    console.warn(
      '[push-notify] failures:',
      results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message),
    );
  }

  return json({ sent, failed });
});
