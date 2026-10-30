# Ride App — Architecture & Delivery Plan ("The Way")

A real-time ride-booking platform (Uber / PickMe style) for an initial fleet of
**10 riders**, built to scale to hundreds without re-architecture.

This document is the plan. Implementation follows it phase by phase.

---

## 1. Guiding constraints

1. **Zero-cost to run.** Supabase free tier + Vercel free tier + OpenStreetMap.
   No credit card required to get a working deployment.
2. **The database is the source of truth**, including for time. No browser timer
   is ever authoritative.
3. **Security lives in Postgres**, not in React. Every table has RLS. The
   frontend never sends a user id that the backend trusts.
4. **One rider, one booking.** Enforced by atomic SQL, not application logic.

---

## 2. Technology decisions

| Layer | Choice | Why |
|---|---|---|
| UI | React 18 + TypeScript (strict) + Vite | Spec; fast builds |
| Styling | Tailwind CSS v3 + shadcn-style primitives on Radix | Spec; no runtime cost |
| Icons | lucide-react | Spec |
| Routing | React Router v6 | Spec |
| Server state | TanStack Query v5 | Spec; dedupe + cache |
| Forms / validation | react-hook-form + Zod | Spec section 15 |
| Backend | Supabase (Postgres + PostGIS + Auth + Realtime + Edge Functions) | Spec |
| Dispatch timer | **pg_cron** (5 second schedule) calling `dispatch_tick()` | Server-authoritative, free tier |
| Maps | **Provider abstraction**: MapLibre GL + OSM (default) or Google Maps JS API | Spec section 9 asks for a swappable layer |
| Geocoding | Nominatim (default) or Google Geocoding | Free, no key |
| Routing | OSRM (default) or Google Routes | Free, no key |
| Push | Service Worker + Notifications API (default) or FCM | Works with no third-party setup |
| Hosting | Vercel (static SPA) + Supabase cloud | Free |

### 2.1 Why not a Node worker for dispatch?

The 10-second sequential dispatch needs a server-side clock. Options considered:

- NO - `setTimeout` in the customer's browser. Spec section 21.6 forbids it; dies on tab close.
- NO - Dedicated Node/Redis worker. Needs an always-on paid instance.
- YES - **`pg_cron` calling `dispatch_tick()` every 5 seconds.** Available on
  the Supabase free tier, survives everything, and the timer lives beside the
  data it guards. Offer deadlines are stored as `booking_dispatches.expires_at`;
  the tick only *reaps* them, so a late tick can never double-assign.
- YES - Fallback: `supabase/functions/dispatch-tick` exposes the same SQL
  function over HTTP for an external cron (GitHub Actions, cron-job.org) if a
  project cannot enable `pg_cron`.

Browsers still render a countdown, but purely as a **display** of `expires_at`.
Acceptance is validated server-side against the stored deadline.

---

## 3. Data model

```
auth.users (Supabase)
    | 1:1  (trigger on insert)
    v
profiles ---------------+--------------------------+
 id, role, full_name    | role='rider'             | role='customer'
 phone, avatar_url      v                          v
                      riders                   bookings  <-- customer_id
                       is_active                 pickup_* destination_*
                       availability              estimated_distance/duration
                       rating, total_rides        status (state machine)
                       +-- vehicles               timestamps per transition
                       +-- rider_locations        rider_id --+
                            location geography     |         |
                            heading/speed/acc      |         |
                            last_seen (freshness)  v         |
                               booking_dispatches <----------+
                                booking_id, rider_id, sequence
                                distance_m, status, expires_at

booking_events      append-only audit of every status change
notifications       in-app inbox, realtime
device_tokens       FCM registration tokens per user
admin_settings      tunables (dispatch window, radius, GPS staleness)
```

### 3.1 Spatial representation

`rider_locations.location geography(Point, 4326)` with a **GiST index**, kept in
sync with the plain `latitude`/`longitude` columns by a trigger (so the client
never has to speak WKB). Nearby search uses `ST_DWithin` for the index-backed
filter and `ST_Distance` for ranking.

### 3.2 Booking state machine

```
                    +---------------> no_rider_available --(retry)--+
                    |                                               |
  searching --------+---------------> assigned --> rider_arriving --> arrived
      |             |                    |              |              |
      +-------------+--------------------+--------------+--------------+
                         cancelled <------------------------ in_progress
                                                                      |
                                                                 completed
```

Transitions are validated inside `advance_booking_status()`; illegal
transitions raise an exception. Every accepted transition appends a
`booking_events` row.

---

## 4. The dispatch algorithm (spec section 7)

**Candidate eligibility** (`find_nearby_riders`):
`is_active` AND `availability = 'online'` AND
`last_seen > now() - gps_stale_seconds` AND not already offered this booking
AND not holding another live booking AND
`ST_DWithin(location, pickup, search_radius_m)`.

Ranked by `ST_Distance` ascending (straight-line, per spec).

**Sequence** — strictly one at a time:

```
t=0s    offer_next_rider()  -> dispatch #1, expires_at = now() + 10s
t=5s    dispatch_tick()     -> #1 pending, deadline not reached -> no-op
t=10s   dispatch_tick()     -> #1 deadline passed -> status='timeout'
                            -> offer_next_rider() -> dispatch #2
...     repeat until accept / exhausted / cancelled / booking expired
```

Reject short-circuits the wait: `reject_booking()` marks the offer `rejected`
and immediately calls `offer_next_rider()` in the same transaction.

**Atomic acceptance** — the race in spec section 19.8 is closed by a single
conditional update:

```sql
UPDATE bookings SET rider_id = me, status = 'assigned', accepted_at = now()
 WHERE id = p_booking AND status = 'searching' AND rider_id IS NULL
RETURNING id;   -- zero rows => someone else won => raise 'booking_taken'
```

Row-level locks serialise concurrent accepts; the loser gets a clean error.
On success: rider becomes `busy`, all sibling offers become `cancelled`, the
customer is notified, and remaining riders' cards disappear via Realtime.

---

## 5. Authorization model (RLS)

| Table | customer | rider | admin |
|---|---|---|---|
| `profiles` | own row; counterparty name/phone of a **live** shared booking | same | all |
| `riders` / `vehicles` | read-only for assigned rider | own row RW | all |
| `rider_locations` | **only** the rider on their own live booking | own row RW | all |
| `bookings` | own rows | assigned rows + rows offered to them | all |
| `booking_dispatches` | own booking's rows | own offers | all |
| `notifications` | own | own | all |

`rider_locations` is the privacy-critical table: a customer's SELECT policy
requires an `EXISTS` on a booking they own whose status is live. This is what
stops the whole fleet's live position from leaking (spec sections 8 and 21.8).
Supabase Realtime evaluates these same policies, so the subscription is
filtered too.

---

## 6. Folder structure

```
Ride_App/
+- ARCHITECTURE.md  README.md  TESTING.md  DEPLOYMENT.md  .env.example
+- supabase/
|  +- migrations/      0001..0007  (extensions -> tables -> funcs -> RLS -> cron -> seed)
|  +- functions/       dispatch-tick/  push-notify/
+- public/             manifest.webmanifest  sw.js  firebase-messaging-sw.js  icons/
+- src/
   +- lib/             supabase.ts  env.ts  utils.ts  query.ts  geo.ts
   +- types/           database.ts  domain.ts
   +- components/
   |  +- ui/           button card input dialog badge sheet switch select ...
   |  +- shared/       AppShell  MapCanvas  StatusBadge  EmptyState  InstallPrompt
   +- features/
   |  +- auth/           AuthProvider  guards  Login  Register
   |  +- map/            provider.ts  maplibre.ts  google.ts  geocoding.ts  routing.ts
   |  +- gps/            useGeolocation  useRiderTracker
   |  +- booking/        api.ts  hooks.ts
   |  +- dispatch/       api.ts  hooks.ts
   |  +- notifications/  api.ts  hooks.ts  push.ts  fcm.ts
   +- pages/
   |  +- customer/     Home  Track  History
   |  +- rider/        Dashboard  ActiveRide  History
   |  +- admin/        Overview  Riders  Bookings  LiveMap  Settings
   +- App.tsx  routes.tsx  main.tsx  index.css
```

Rule: **no Supabase call inside a component.** Components use hooks; hooks call
`features/*/api.ts`; api modules call RPCs. Business logic lives in SQL.

---

## 7. Delivery phases

| # | Scope | Done when |
|---|---|---|
| 1 | Scaffold, design system, migrations, auth, roles | `npm run build` clean; signup creates a profile with the right role; guards redirect |
| 2 | Customer map, pickup/destination, estimate, create booking | Booking row appears with coordinates plus distance/duration |
| 3 | Rider dashboard, online/offline, GPS writer | `rider_locations` updates while moving, stops when offline |
| 4 | Nearest-rider search, 10s sequential dispatch, atomic accept | Offers arrive one at a time, 10s apart; simultaneous accept yields one winner |
| 5 | Live tracking, route display, notifications | Customer sees rider marker move in realtime; status pushes arrive |
| 6 | Admin dashboard | Stats, rider CRUD, booking management, live fleet map |
| 7 | Hardening, docs, deploy | README/TESTING complete, 15 scenarios documented, Vercel build green |

---

## 8. Known limitations (stated, not hidden)

1. **Browser GPS stops when the phone locks.** Unavoidable for a PWA. Mitigated
   by `last_seen` freshness: a stale rider is skipped by dispatch and shown as
   stale in admin. A native wrapper is the migration path (spec section 16).
2. **OSRM and Nominatim public endpoints are rate-limited** and not intended for
   heavy production traffic. Fine for 10 riders; swap in Google keys or
   self-host to scale. The provider layer makes this a config change.
3. **`pg_cron` ticks every 5 seconds**, so a 10-second offer window is observed
   as 10-15s in the worst case. Deadlines are exact in the data; only reaping is
   coarse. Tighten by lowering the tick interval or using the Edge Function.
