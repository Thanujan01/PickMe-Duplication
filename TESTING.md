# Testing

Three layers, cheapest first:

1. **[SQL suite](#1-sql-suite)** — 25 automated assertions against the real
   dispatch functions. Start here; it covers the logic that matters most.
2. **[Manual walkthroughs](#2-manual-walkthroughs)** — the full product, two or
   three browsers, covering every scenario in the spec.
3. **[Hard cases](#3-hard-cases)** — true concurrency, offline, stale GPS,
   and the privacy boundary.

A note on honesty: there is no automated browser test suite in this repository.
What is automated is the dispatch algorithm and the authorization model — the
parts where a bug is expensive and a human cannot reliably eyeball the result.
The UI is verified manually, with the exact steps written out below.

---

## 1. SQL suite

```sql
-- Supabase SQL Editor, after all migrations:
-- 1. paste supabase/tests/dispatch_test.sql and run it (defines the suite)
-- 2. then:
select * from public.run_dispatch_tests();
```

Expected: 25 rows, every `result` = `PASS`.

```
 n  | test                                                        | result
----+-------------------------------------------------------------+--------
  1 | find_nearby_riders ranks nearest first                       | PASS
  2 | exactly one offer created, to the nearest rider              | PASS
  3 | no parallel offers while one is pending                      | PASS
  4 | offer window matches dispatch_window_seconds                 | PASS
  5 | reject marks rejected and offers rider 2 at once             | PASS
  6 | dispatch_tick times out rider 2 and offers rider 3           | PASS
  7 | offline rider 4 skipped, rider 5 offered instead             | PASS
  8 | rider with stale GPS is not an eligible candidate            | PASS
  9 | accept assigns the booking and marks the rider busy          | PASS
 10 | no offers left pending after acceptance                      | PASS
 11 | second accept is refused with booking_taken                  | PASS
 ...
 25 | customer cannot read the location of a rider they are not …  | PASS
```

The suite creates its own `ridetest+*@example.com` accounts, drives the real
functions, and deletes everything it made. It never touches your data.

When finished:

```sql
select public.cleanup_dispatch_tests();
```

### If the suite fails to create its fixtures

It inserts directly into `auth.users`, which a future Supabase schema change
could reject. If you see an error from `_dt_make_user`, create six accounts
through the app instead (`ridetest+customer@…`, `ridetest+r1@…` … `r5`), comment
out the `_dt_make_user` fixture block, and look the ids up with:

```sql
select id, email from auth.users where email like 'ridetest+%';
```

The assertions themselves are independent of how the accounts were made.

### Spec scenario coverage

| # | Spec scenario | Covered by |
|---|---|---|
| 1 | Customer creates a booking | SQL 20–22, Manual A |
| 2 | Nearest rider receives the request first | SQL 1, 2 |
| 3 | First rider rejects | SQL 5 |
| 4 | Second rider receives it immediately | SQL 5 |
| 5 | First rider does not respond within 10s | SQL 6 |
| 6 | Second rider receives it after the timeout | SQL 6 |
| 7 | Rider accepts | SQL 9, 10 |
| 8 | Two riders accept simultaneously | SQL 11, 12 + [Hard case 1](#hard-case-1-a-genuine-accept-race) |
| 9 | Rider goes offline during dispatch | SQL 7 |
| 10 | Rider GPS becomes outdated | SQL 8, [Hard case 3](#hard-case-3-stale-gps) |
| 11 | Customer cancels during dispatch | SQL 17, 18 |
| 12 | All riders reject or time out | SQL 15, 16 |
| 13 | Network disconnects during an active ride | [Hard case 2](#hard-case-2-network-loss-mid-ride) |
| 14 | Rider reconnects | [Hard case 2](#hard-case-2-network-loss-mid-ride) |
| 15 | Rider completes a trip | SQL 13, 14, Manual B |

---

## 2. Manual walkthroughs

### Setup

You need three signed-in sessions. Use separate browser profiles or windows —
**not** two tabs of the same profile, which share one Supabase session.

| Window | Account | Opens |
|---|---|---|
| 1 | customer | `/` |
| 2 | rider A | `/rider` |
| 3 | admin | `/admin/fleet` |

For a second rider, add a fourth window (or a phone on the same LAN —
`npm run dev` binds to your network address).

**Fast positioning without walking around:** Chrome DevTools → ⋮ → More tools →
Sensors → Location → Custom, then set coordinates. Or place riders from SQL:

```sql
select public.dev_place_rider('rider1@example.com', 6.9271, 79.8612);
select public.dev_place_rider('rider2@example.com', 6.9350, 79.8700);
```

To make a run finish fast, shrink the windows (remember to restore them):

```sql
select public.admin_set_setting('dispatch_window_seconds', '10'::jsonb);
select public.admin_set_setting('search_timeout_seconds',  '60'::jsonb);
```

---

### A. Booking and dispatch

1. **Window 2** — rider A: flip the toggle to online.
   - ✅ Browser asks for location permission.
   - ✅ Status strip reads **Online** and "synced Ns ago".
   - ✅ **Window 3** (admin): rider A's marker appears on the live map within
     ~15 seconds.
2. **Window 1** — customer: allow location.
   - ✅ Map centres on you; pickup pre-filled with a reverse-geocoded address.
3. Tap the destination row, search a place, pick a result.
   - ✅ Route line, distance, duration and per-class fares appear.
4. Tap **Book ride**.
   - ✅ Panel switches to **Finding your rider** with a progress strip.
   - ✅ **Window 2** — rider A sees the request card within a second or two,
     countdown running from 10.
5. Let it expire without touching it.
   - ✅ Card disappears when the countdown hits zero.
   - ✅ Customer's "contacted N riders" increments within ~5 seconds (one
     `dispatch_tick`).
   - ✅ With a second rider online, *they* now get the card.
6. Accept on whichever rider holds the card.
   - ✅ Customer panel switches to the rider card: name, rating, vehicle, plate,
     call button, ETA.
   - ✅ Other riders' cards vanish.
   - ✅ Admin map shows that rider as **On a ride**.

Verify the ledger:

```sql
select sequence, rider_id, status, distance_m,
       expires_at - offered_at as window
from booking_dispatches
where booking_id = '<id>'
order by sequence;
```

Expect strictly increasing `distance_m`, exactly one `accepted`, and no two rows
`pending` at the same time.

---

### B. The ride

7. **Window 2** — **Start heading to pickup**.
   - ✅ Customer status → **On the way**; marker animates smoothly, not in jumps.
   - ✅ Route drawn rider → pickup.
8. Move the rider's simulated location.
   - ✅ Customer marker follows, with the arrow pointing along travel direction.
   - ✅ ETA updates — but the routing service is only re-queried after ~150 m of
     movement. Watch the Network tab: no request per GPS fix.
9. **I've arrived** → ✅ customer sees the green "waiting at the pickup point"
   banner.
10. **Start trip** → ✅ status **In progress**; route switches to
    pickup → destination; customer's cancel button disappears.
11. **Complete trip** → confirm.
    - ✅ Customer returns to the booking screen.
    - ✅ Rider returns to **Online**; "Rides today" increments.
    - ✅ The ride appears in both histories; `/trip/:id` shows the full timeline.

---

### C. No rider available

12. Take every rider offline. Book a ride.
    - ✅ Status becomes **No riders available** (immediately — there are no
      candidates to contact).
    - ✅ **Try again** is offered.
13. Bring a rider online, press **Try again**.
    - ✅ Search restarts and that rider — *even if contacted in the previous
      round* — gets the card. (`retry_booking_dispatch` clears the ledger;
      `booking_events` keeps the history.)
14. As admin → **Bookings** → filter **Unfulfilled** → **Assign rider**.
    - ✅ Rider is assigned directly, customer is notified, dispatch stops.

---

### D. Cancellation

15. Book, then cancel while **Finding your rider**.
    - ✅ Confirmation dialog appears.
    - ✅ Any rider holding the card loses it.
    - ✅ No new offer appears on the next tick.
16. Book, let a rider accept, then cancel as the customer.
    - ✅ Dialog warns that the rider is already on the way.
    - ✅ Rider is notified and returns to **Online**.
17. Start a trip, then try to cancel as the customer.
    - ✅ No cancel button is shown.
    - ✅ Calling it anyway is refused server-side. Run this in the **customer's**
      browser console with `npm run dev` (the SQL editor has no session, so it
      would raise `not_authenticated` instead and prove nothing):

```js
await window.__ride.supabase.rpc('cancel_booking', {
  p_booking_id: '<in-progress booking id>', p_reason: 'test',
});
// ✅ error.message === 'trip_in_progress'
```

18. As admin, cancel the same in-progress booking.
    - ✅ Allowed — admins can intervene.

---

### E. Admin dashboard

19. **Overview** — counts match reality; **GPS stale** shows a warning only when
    a rider is online but not reporting.
20. **Riders** — search by name, phone or plate; **Edit** saves a vehicle;
    **Deactivate** is refused for a rider mid-ride:

```sql
select public.admin_set_rider_active('<rider on a ride>', false);
-- ERROR: rider_has_active_booking
```

21. **Bookings** — every filter returns the right set; search matches an address
    fragment and a booking-id prefix.
22. **Live map** — tap a marker for phone, rating, last fix, accuracy, speed.
23. **Settings** — change `dispatch_window_seconds` to 20 and book again.
    - ✅ The new countdown is 20 seconds, with no redeploy. (Confirms the SQL
      functions read `admin_settings` at call time.)

---

### F. PWA and mobile

24. Deployed over HTTPS on Android Chrome: install prompt appears; installed app
    opens full-screen with no browser chrome.
25. Rotate and resize: the map fills the viewport; bottom sheets stay reachable;
    nothing scrolls horizontally.
26. Grant notification permission as a rider, background the app, and have a
    customer book.
    - ✅ A system notification arrives (tab backgrounded).
    - ⚠️ With the app fully closed, this only works if Firebase is configured —
      see README §4.
27. Tap the notification → ✅ the app focuses on `/rider`.

---

## 3. Hard cases

### Hard case 1: a genuine accept race

SQL assertion 11 proves the guard rejects a second accept. To prove it under
real concurrency you need two sessions hitting it at the same instant.

1. Sign in as two riders in two browsers, both online, both near the pickup.
2. Create a booking and let the *first* rider's offer time out so the second is
   offered — then manually re-open the first rider's offer so both are pending:

```sql
update booking_dispatches
   set status = 'pending', expires_at = now() + interval '60 seconds'
 where booking_id = '<id>';
```

3. Click **Accept** in both windows as close together as you can. To get them
   genuinely simultaneous, run this in each browser's console (dev build) and
   press Enter in both:

```js
// fires on the next tick, so two windows can be lined up
setTimeout(() => window.__ride.supabase
  .rpc('accept_booking', { p_booking_id: '<id>' })
  .then(r => console.log(r.error?.message ?? 'WON')), 3000);
```

**Expected:** exactly one window shows "Ride accepted"; the other shows
*"Another rider accepted this ride first."* Then:

```sql
select rider_id, status from bookings where id = '<id>';
select rider_id, status from booking_dispatches where booking_id = '<id>';
```

✅ One `rider_id`, status `assigned`, exactly one `accepted` dispatch row.

Why it holds: both transactions attempt
`UPDATE bookings SET … WHERE id = $1 AND status = 'searching'`. Postgres
serialises them on the row lock and **re-evaluates the WHERE clause after
acquiring it**, so the second matches zero rows and raises `booking_taken`. The
partial unique index `bookings_one_live_per_rider_idx` is a second line of
defence.

---

### Hard case 2: network loss mid-ride

1. Start a trip.
2. **Rider window** → DevTools → Network → **Offline**. Wait ~40 seconds.
   - ✅ Rider sees "Your location is not reaching the server" after three failed
     writes.
   - ✅ Customer's marker freezes at the last known position — it does not jump
     to zero or disappear.
   - ✅ Admin shows the rider as **GPS stale**.
3. Set Network back to **Online**.
   - ✅ Location writes resume within ~5 seconds; the warning clears.
   - ✅ Customer marker animates to the current position.
   - ✅ Realtime reconnects on its own; no reload needed.
4. Confirm the ride is unaffected:

```sql
select status, started_at from bookings where id = '<id>';
```

✅ Still `in_progress`. A dropped connection never changes booking state.

---

### Hard case 3: stale GPS

This is the limitation the spec calls out, so test it deliberately.

1. Rider online, then lock the phone (or set DevTools Network to Offline).
2. Wait past `gps_stale_seconds` (default 45).
3. Create a booking from a customer nearby.

```sql
select * from public.find_nearby_riders('<booking id>', 10);
```

✅ The stale rider is **not** in the result — dispatch skips them.

4. Wait past three staleness windows (~135 s) and let a tick run:

```sql
select public.dispatch_tick();
select availability from riders where id = '<rider id>';
```

✅ `offline`. The platform parks a rider it can no longer locate rather than
sending them a request they cannot serve.

---

### Hard case 4: the privacy boundary

The most important authorization claim in the system: **a customer can only see
the position of the rider driving their own live booking.**

SQL assertion 25 checks this automatically. To see it yourself, as a customer
with **no** active ride, run in the browser console:

```js
const { supabase } = window.__ride;   // dev build only
const { data, error } = await supabase.from('rider_locations').select('*');
console.log(data, error);
```

✅ `data` is `[]` — not an error, and not the fleet. RLS filters rather than
rejects.

Now with a live assigned booking, run it again:

✅ Exactly **one** row: your assigned rider.

Same check for the realtime stream — subscribe to `rider_locations` with no
filter as a customer and confirm you only receive events for your own rider.

Other boundaries worth a minute each:

```js
const { supabase } = window.__ride;
const myId = (await supabase.auth.getUser()).data.user.id;

// A customer cannot read other people's bookings.
await supabase.from('bookings').select('id, customer_id');
// ✅ only your own rows

// A customer cannot promote themselves.
await supabase.from('profiles').update({ role: 'admin' }).eq('id', myId);
// ✅ error: role_change_forbidden

// A rider cannot fake being online.
await supabase.from('riders').update({ availability: 'online' }).eq('id', myId);
// ✅ error: no UPDATE grant on riders

// A rider cannot inflate their own stats.
await supabase.from('riders').update({ total_rides: 9999 }).eq('id', myId);
// ✅ same

// A customer cannot write a booking directly.
await supabase.from('bookings').insert({ /* … */ });
// ✅ error: no INSERT grant
```

---

## 4. Build checks

```bash
npm run lint     # tsc --noEmit, strict mode, no unused locals
npm run build    # type-check + production bundle
npm run preview  # verify the built app, including the service worker
```

The service worker only registers in a production build, so install, offline
shell and notification-click behaviour must be tested via `preview` or a real
deploy — not `npm run dev`.

---

## 5. Keeping an eye on it in production

```sql
-- Is the dispatch clock alive?
select jobname, last_run_finished_at, status
from cron.job_run_details
order by start_time desc limit 10;

-- Bookings stuck searching longer than they should be
select id, created_at, dispatch_round, search_expires_at
from bookings
where status = 'searching' and created_at < now() - interval '4 minutes';

-- Riders claiming to be online but not reporting
select r.id, p.full_name, rl.last_seen
from riders r
join profiles p on p.id = r.id
left join rider_locations rl on rl.rider_id = r.id
where r.availability = 'online'
  and (rl.last_seen is null or rl.last_seen < now() - interval '45 seconds');

-- Dispatch health: how often does nobody accept?
select status, count(*)
from booking_dispatches
where offered_at > now() - interval '24 hours'
group by status;

-- Full audit trail for one booking
select created_at, event_type, from_status, to_status, metadata
from booking_events
where booking_id = '<id>'
order by created_at;
```
