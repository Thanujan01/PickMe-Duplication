# Ride

A real-time ride-booking platform — customer app, rider app and admin dashboard
— built for an initial fleet of **10 riders** and designed to scale without
re-architecture.

Runs entirely on free tiers. **No credit card required.**

```
React 18 + TypeScript + Vite + Tailwind  │  Supabase (Postgres + PostGIS + Auth + Realtime)
MapLibre GL + OpenStreetMap (default)    │  pg_cron drives the dispatch clock
Vercel (frontend)                        │  Google Maps / Firebase optional
```

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — design decisions and the delivery plan
- [`TESTING.md`](./TESTING.md) — how to verify every scenario, including the dispatch race

---

## What it does

**Customers** detect their location, pick a pickup and destination on a map, see
distance/time/fare before booking, then watch their rider approach in real time
with name, photo, vehicle, plate number and a one-tap call button.

**Riders** go online, stream GPS, receive one ride request at a time with a
10-second countdown, accept or decline, navigate with Google Maps, then mark
arrival, start and completion.

**Administrators** see live fleet positions on a map, manage rider accounts and
vehicles, search and filter every booking, manually assign or cancel a ride, and
tune dispatch parameters without a redeploy.

### The core feature: sequential nearest-rider dispatch

When a booking is created, the platform contacts **one rider at a time**, nearest
first, giving each exactly 10 seconds:

```
t=0s    nearest eligible rider        offered   (expires_at = now + 10s)
t=10s   no response → timeout         next rider offered
        rider declines → immediately  next rider offered
        rider accepts  → dispatch stops, everyone else's card disappears
        nobody left    → no_rider_available, customer can retry
```

Three properties matter, and all three are enforced in Postgres rather than in
the browser:

| Property | How |
|---|---|
| The 10-second clock is server-side | `expires_at` stored per offer; `pg_cron` runs `dispatch_tick()` every 5s to reap deadlines |
| Only one rider can ever win | A single conditional `UPDATE ... WHERE status='searching'`; the loser gets `booking_taken` |
| No rider sees another customer's position | RLS on `rider_locations` requires an `EXISTS` on a booking the reader owns |

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20+ | `node -v` |
| npm | 10+ | ships with Node |
| A Supabase account | free tier | <https://supabase.com/dashboard> |
| A Vercel account | free tier | only needed to deploy |

Everything else is optional. Google Maps and Firebase are **not** required.

---

## Quick start

```bash
git clone <your-repo-url> ride-app
cd ride-app
npm install
cp .env.example .env     # then fill in the two Supabase values (below)
npm run dev              # http://localhost:5173
```

If `.env` is missing or incomplete, the app renders a configuration screen that
names the exact variables it needs instead of showing a blank page.

---

## 1. Supabase setup

### 1.1 Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Pick a region near your riders (for Sri Lanka: Singapore / Mumbai).
3. Save the database password somewhere safe.

### 1.2 Enable the extensions

**Database → Extensions**, enable:

| Extension | Why |
|---|---|
| `postgis` | spatial index + distance for nearby-rider search |
| `pg_cron` | **the dispatch clock** — without it offers never time out |
| `pg_net` | optional; only for the Firebase push relay |

`postgis` and `pg_cron` are both available on the free tier. The migrations also
try to `create extension`, but enabling from the dashboard is more reliable.

### 1.3 Apply the migrations

**Option A — SQL editor (no tooling).** Open **SQL Editor** and run each file
from `supabase/migrations/` **in order**, one at a time:

```
0001_extensions_and_types.sql
0002_tables.sql
0003_helpers_and_triggers.sql
0004_dispatch.sql
0005_rls.sql
0006_realtime_and_cron.sql
0007_bootstrap.sql
```

**Option B — Supabase CLI.**

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

### 1.4 Confirm the dispatch clock is running

```sql
select jobname, schedule, active from cron.job;
```

You should see:

```
 jobname              | schedule    | active
----------------------+-------------+--------
 ride-dispatch-tick   | 5 seconds   | t
 ride-nightly-cleanup | 17 3 * * *  | t
```

If `ride-dispatch-tick` is missing, migration `0006` raised a warning because
`pg_cron` was not enabled. Enable it, then re-run `0006`.

> **If you cannot enable `pg_cron`**, deploy the `dispatch-tick` Edge Function
> and call it from an external scheduler every 5–10 seconds. See
> [Dispatch without pg_cron](#dispatch-without-pg_cron). The platform will not
> advance offers without one of the two.

### 1.5 Copy your API keys

**Project Settings → API** → put these in `.env`:

```env
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

The **anon** key is designed to be public — Row Level Security is what protects
your data. Never put the **service_role** key in `.env` or any `VITE_` variable;
it bypasses RLS entirely.

### 1.6 Auth settings

**Authentication → Providers → Email**:

- For a quick trial, turn **Confirm email** *off* so signups can sign in at once.
- For production, leave it **on** and set **Authentication → URL Configuration**:
  - Site URL: `https://your-app.vercel.app`
  - Redirect URLs: add `https://your-app.vercel.app/reset-password`

---

## 2. Create the first accounts

### Administrator

`admin` is deliberately **not** self-assignable at signup, so nobody can
register their way into your dashboard. Promote an account once, by hand:

1. Register normally at `/register` (either account type).
2. In the **SQL Editor**:

```sql
select public.promote_to_admin('you@example.com');
```

3. Sign out and back in. You land on `/admin`.

### Riders

Two supported paths:

**A — rider self-registers (recommended).** They open `/register`, choose
**“I drive”**, and appear in **Admin → Riders** immediately. You then press
**Edit** to add their vehicle. *A rider with no vehicle is never matched.*

**B — you create the account for them.** Requires the service-role key, so it
runs in an Edge Function, never in the browser:

```bash
npx supabase functions deploy admin-create-rider
```

Then, signed in as an admin:

```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/admin-create-rider" \
  -H "Authorization: Bearer <your admin access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "rider1@example.com",
    "password": "temporary-password",
    "full_name": "Nuwan Silva",
    "phone": "+94771234567",
    "vehicle_type": "car",
    "make": "Toyota", "model": "Axio", "color": "Silver",
    "plate_number": "CAB-1234"
  }'
```

The function verifies from the database that the caller is an admin before it
touches the privileged key.

### Customers

Just register at `/register` and choose **“I need rides”**.

---

## 3. Maps and routing

The map provider is a **configuration choice**, not a code change
(`src/features/map/`).

### Default: MapLibre + OpenStreetMap (free, no key, no card)

```env
VITE_MAP_PROVIDER=maplibre
VITE_GEO_PROVIDER=osm
```

| Capability | Service | Notes |
|---|---|---|
| Basemap | OpenStreetMap raster tiles | no key |
| Address search | Nominatim | no key, **rate-limited** |
| Reverse geocoding | Nominatim | cached client-side |
| Road routes + ETA | OSRM demo server | no key, **rate-limited** |

Fine for 10 riders and for development. The public Nominatim and OSRM endpoints
are shared community infrastructure with usage policies — searches are debounced
to 450 ms and routes are cached in ~100 m buckets to respect that. For real
production volume, self-host them or switch to Google below.

A nicer vector basemap, still free: get a [MapTiler](https://maptiler.com) key
and set

```env
VITE_MAPLIBRE_STYLE_URL=https://api.maptiler.com/maps/streets-v2/style.json?key=YOUR_KEY
```

### Optional: Google Maps

Requires a Google Cloud project **with billing enabled** (there is a monthly
free credit, but a card is mandatory).

1. <https://console.cloud.google.com> → new project.
2. Enable **Maps JavaScript API**, **Geocoding API**, **Directions API**.
3. Create an API key, then **restrict it**: Application restrictions → HTTP
   referrers → `localhost:5173/*` and `your-app.vercel.app/*`.

```env
VITE_MAP_PROVIDER=google
VITE_GEO_PROVIDER=google
VITE_GOOGLE_MAPS_API_KEY=AIza...
```

You can mix: `VITE_MAP_PROVIDER=maplibre` with `VITE_GEO_PROVIDER=google` gives
free tiles with Google's address search.

If the key is missing or rejected, the map shows an inline explanation and the
rest of the app keeps working.

> Rider turn-by-turn navigation always uses a plain `google.com/maps/dir/` link,
> which needs no key at all.

### Starting map position

```env
VITE_DEFAULT_MAP_LAT=6.9271   # Colombo
VITE_DEFAULT_MAP_LNG=79.8612
VITE_DEFAULT_MAP_ZOOM=13
```

---

## 4. Notifications

### Default: works with zero setup

Every status change inserts a `notifications` row, which arrives over Supabase
Realtime and is raised as a browser notification through the service worker. New
ride requests also vibrate and beep the rider's device.

This reaches an **open or backgrounded** tab. It cannot reach a fully closed app
— no web technology can without a push service.

### Optional: Firebase Cloud Messaging

Adds delivery to a closed app.

1. <https://console.firebase.google.com> → new project → add a **Web** app.
2. **Project settings → Cloud Messaging** → generate a **Web Push certificate**
   (the VAPID key pair).
3. Fill in `.env`:

```env
VITE_FCM_ENABLED=true
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_VAPID_KEY=B...
```

4. **Also edit `public/firebase-messaging-sw.js`** and paste the same config
   into `FIREBASE_CONFIG`. A service worker cannot read Vite env vars, so this
   one file has to be filled in by hand. (These values are not secrets; they
   ship in every Firebase web app.)

5. Deploy the relay, which holds the service-account key server-side:

```bash
# Project settings → Service accounts → Generate new private key
npx supabase secrets set FCM_SERVICE_ACCOUNT_JSON="$(cat service-account.json)"
npx supabase secrets set PUSH_RELAY_SECRET="$(openssl rand -hex 32)"
npx supabase functions deploy push-notify --no-verify-jwt
```

6. Point the database at it (SQL editor):

```sql
select public.admin_set_setting('fcm_relay_url',
  '"https://<ref>.supabase.co/functions/v1/push-notify"'::jsonb);
select public.admin_set_setting('fcm_relay_key', '"<PUSH_RELAY_SECRET>"'::jsonb);
```

Leave `fcm_relay_url` unset and the relay simply never fires. Push failures can
never roll back a booking — `push_notification()` swallows them deliberately.

---

## 5. Deploy

### Frontend → Vercel

```bash
npm i -g vercel
vercel
```

Or connect the repository at <https://vercel.com/new>. Vercel detects Vite via
`vercel.json`; no settings to change.

**Add every `VITE_` variable** under **Settings → Environment Variables**, then
redeploy. A deploy with no Supabase variables shows the configuration screen
rather than a broken app.

After the first deploy, go back and add the Vercel URL to:

- Supabase **Authentication → URL Configuration** (Site URL + redirect URLs)
- your Google Maps key's HTTP-referrer restrictions, if you use Google

HTTPS comes free with Vercel, which the PWA, geolocation and notifications all
require.

### Install as an app

Open the deployed URL on Android Chrome → **Install app** (or the in-app
prompt). Desktop Chrome and Edge show an install icon in the address bar.

> **Known limitation, stated plainly:** browser GPS stops when a phone locks the
> screen or the browser is suspended. The platform handles this honestly rather
> than pretending otherwise: `last_seen` freshness is checked on every dispatch,
> a stale rider is skipped and shown as *GPS stale* to admins, and
> `dispatch_tick()` parks a rider offline after three staleness windows. Riders
> should keep the screen on while working. For guaranteed background tracking
> the migration path is a native Android wrapper around this same backend.

---

## Dispatch without pg_cron

If `pg_cron` is unavailable, drive the same SQL function over HTTP:

```bash
npx supabase secrets set DISPATCH_TICK_SECRET="$(openssl rand -hex 32)"
npx supabase functions deploy dispatch-tick --no-verify-jwt
```

Then call it every 5–10 seconds from any scheduler — a GitHub Actions cron,
cron-job.org, Upstash QStash:

```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/dispatch-tick" \
  -H "x-dispatch-secret: <DISPATCH_TICK_SECRET>"
```

Calling it too often is harmless. `dispatch_tick()` only reaps deadlines already
recorded in the database and re-checks every decision under a row lock, so a
late, early or duplicated tick can never double-assign a booking.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | dev server at <http://localhost:5173> (LAN-accessible for phone testing) |
| `npm run build` | type-check then production build to `dist/` |
| `npm run preview` | serve the production build locally |
| `npm run lint` | type-check only |
| `npm run db:push` | apply migrations through the Supabase CLI |
| `npm run db:reset` | **destructive** — rebuild the local database from migrations |

---

## Project layout

```
supabase/
  migrations/      0001 extensions → 0007 bootstrap (apply in order)
  functions/       dispatch-tick · push-notify · admin-create-rider
  tests/           dispatch_test.sql — 25 assertions over the real functions
src/
  lib/             env · supabase client + error mapping · geo maths · query keys
  types/           database.ts mirrors the SQL schema
  components/ui/   shadcn-style primitives on Radix
  components/shared/ AppShell · map-independent UI · states
  features/
    auth/          session + profile + role guards
    map/           provider.ts · maplibre · google · geocoding · routing
    gps/           useGeolocation · useRiderTracker (the GPS writer)
    booking/       customer booking + tracking
    dispatch/       rider offers + in-ride controls
    notifications/ realtime inbox · service-worker + FCM push
    admin/         fleet, bookings, riders
  pages/           customer/ · rider/ · admin/ · auth/
```

**One rule throughout:** no Supabase call inside a component. Components use
hooks, hooks call `features/*/api.ts`, and api modules call SQL functions.
Business logic lives in SQL where it can be enforced.

---

## Security model

The frontend is a rendering layer. Every rule that matters is in the database.

- **Every table has RLS.** `bookings`, `booking_dispatches`, `booking_events` and
  `riders` grant **no** write access to browser roles at all — mutations only
  happen through `SECURITY DEFINER` functions that derive the actor from
  `auth.uid()`. No function trusts a caller-supplied identity.
- **Rider positions are not public.** A customer can read exactly one rider's
  location: the one driving their own live booking. Realtime applies the same
  policy, so the websocket is filtered identically.
- **Phone numbers are disclosed narrowly** — only between the two people on a
  booking, and only while it is live.
- **Privilege escalation is blocked** by a trigger: a non-admin cannot change
  their own `role` or `is_blocked`.
- **Rider state is platform-owned.** `availability`, `is_active`, `rating` and
  `total_rides` cannot be written from a browser; `busy` is set only by the
  dispatcher.
- **Acceptance is atomic.** One conditional `UPDATE` decides the winner.
- **Booking creation is idempotent** via a per-intent key, so a retry after a
  network blip cannot create a second ride.
- **Input is validated twice** — Zod in the browser for fast feedback, and again
  in SQL where it is binding.
- **Secrets stay server-side.** The service-role key and the FCM service account
  exist only as Edge Function secrets. Nothing secret is ever `VITE_`-prefixed.

---

## Troubleshooting

**Offers never move to the next rider.**
`select jobname, active from cron.job;` — if `ride-dispatch-tick` is absent,
`pg_cron` is not enabled. See [1.4](#14-confirm-the-dispatch-clock-is-running).

**“We need your location before you can go online.”**
`set_rider_availability('online')` requires a GPS fix newer than
`gps_stale_seconds`. Allow location permission; on desktop Chrome, geolocation
needs `localhost` or HTTPS.

**No riders are ever found.**
Check, in order: at least one rider is `online`; `is_active` is true; their
`rider_locations.last_seen` is recent; they are within `dispatch_radius_m` of
the pickup; **they have a vehicle whose type matches the booking**. A rider with
no vehicle row at all is allowed; a rider whose only vehicle is a bike will not
be offered a car booking.

**The customer map shows no rider marker.**
The rider location stream is RLS-gated on a *live* booking. Confirm the booking
status is `assigned`/`rider_arriving`/`arrived`/`in_progress` and that
`rider_locations` has a row for that rider.

**“Another rider accepted this ride first.”**
Working as designed — that is the atomic claim rejecting the loser of a race.

**Realtime updates stop after a while.**
Confirm the tables are published:
`select tablename from pg_publication_tables where pubname = 'supabase_realtime';`
Migration `0006` adds them and sets `replica identity full`, which Realtime
needs to evaluate RLS on updates.

**Address search returns nothing.**
The public Nominatim endpoint rate-limits. Wait a moment, or switch
`VITE_GEO_PROVIDER` to `google`.

**Signup succeeds but the app says “preparing your account”.**
The `profiles` row is created by a trigger on `auth.users`. If it never appears,
migration `0003` did not apply — re-run it and check
`select tgname from pg_trigger where tgname = 'on_auth_user_created';`

---

## License

MIT. Use it, ship it, change it.
