-- =============================================================================
-- FIX: infinite recursion detected in policy for relation "bookings"
--
-- Symptom: signing in fails with
--     infinite recursion detected in policy for relation "bookings"
--
-- Cause: a policy on `profiles` sub-queried `bookings`, whose policy
-- sub-queried `booking_dispatches`, whose policy sub-queried `bookings` again.
-- Postgres evaluates each referenced table's policy, so that is a cycle.
--
-- Fix: every cross-table check now lives in a SECURITY DEFINER function, which
-- runs as the table owner and therefore does not re-trigger RLS internally.
--
-- Run this whole file in the Supabase SQL editor. It is idempotent and safe to
-- re-run. Nothing is dropped except the policies it immediately recreates, and
-- the permission model is unchanged - only how it is evaluated.
--
-- Already included in migration 0005 for fresh installs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Cross-table visibility helpers
--
-- A policy on table A that sub-queries table B makes Postgres evaluate B's
-- policy, and if B's policy sub-queries A you get:
--
--     ERROR: infinite recursion detected in policy for relation "bookings"
--
-- which is exactly what `profiles -> bookings -> booking_dispatches -> bookings`
-- produced. Every cross-table check therefore lives in a SECURITY DEFINER
-- function: it runs as the table owner, so RLS is not re-evaluated inside it
-- and the cycle is broken.
--
-- These leak nothing. Each one answers a yes/no question about the CALLING
-- user (auth.uid()), never about anyone else, so an authenticated caller can
-- only learn something it is already entitled to know.
-- ---------------------------------------------------------------------------

-- Is p_other the counterparty on a booking the caller is currently on?
create or replace function public.shares_live_booking(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bookings b
    where b.status = any (public.live_booking_statuses())
      and (
        (b.customer_id = auth.uid() and b.rider_id = p_other)
        or (b.rider_id = auth.uid() and b.customer_id = p_other)
      )
  );
$$;

-- Is the caller a rider holding an open offer from customer p_customer?
create or replace function public.has_live_offer_from(p_customer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.booking_dispatches d
    join public.bookings b on b.id = d.booking_id
    where d.rider_id = auth.uid()
      and d.status = 'pending'
      and d.expires_at > now()
      and b.customer_id = p_customer
  );
$$;

-- Is p_rider driving a live booking that the caller owns? This is the single
-- predicate that gates rider_locations, and therefore the whole fleet-privacy
-- guarantee.
create or replace function public.is_my_active_rider(p_rider uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bookings b
    where b.customer_id = auth.uid()
      and b.rider_id = p_rider
      and b.status = any (public.live_booking_statuses())
  );
$$;

-- Has p_booking ever been offered to the caller?
create or replace function public.was_offered_to_me(p_booking uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.booking_dispatches d
    where d.booking_id = p_booking and d.rider_id = auth.uid()
  );
$$;

-- Is the caller the customer on p_booking?
create or replace function public.owns_booking(p_booking uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bookings b
    where b.id = p_booking and b.customer_id = auth.uid()
  );
$$;

-- Is the caller either party on p_booking?
create or replace function public.is_booking_party(p_booking uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bookings b
    where b.id = p_booking
      and (b.customer_id = auth.uid() or b.rider_id = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_admin()
    -- Counterparty disclosure: only while a booking is actually live, and only
    -- between the two people on it (spec section 5 "show rider phone number").
    or public.shares_live_booking(public.profiles.id)
    -- A rider holding a live offer may see the requesting customer's name.
    or public.has_live_offer_from(public.profiles.id)
  );

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles
  for insert to authenticated
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- riders
-- ---------------------------------------------------------------------------
drop policy if exists riders_select on public.riders;
create policy riders_select on public.riders
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_admin()
    or public.is_my_active_rider(public.riders.id)
  );

-- Deliberately no UPDATE policy: see update_rider_profile() above.
drop policy if exists riders_update_own on public.riders;

drop policy if exists riders_admin_insert on public.riders;
create policy riders_admin_insert on public.riders
  for insert to authenticated
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------------
drop policy if exists vehicles_select on public.vehicles;
create policy vehicles_select on public.vehicles
  for select to authenticated
  using (
    rider_id = auth.uid()
    or public.is_admin()
    or public.is_my_active_rider(public.vehicles.rider_id)
  );

drop policy if exists vehicles_write on public.vehicles;
create policy vehicles_write on public.vehicles
  for all to authenticated
  using (rider_id = auth.uid() or public.is_admin())
  with check (rider_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- rider_locations  <-- the privacy-critical table (spec sections 8, 21.8)
--
-- A customer can read exactly one rider's position: the one currently driving
-- their own live booking. Supabase Realtime applies this same policy, so the
-- websocket stream is filtered identically.
-- ---------------------------------------------------------------------------
drop policy if exists rider_locations_select on public.rider_locations;
create policy rider_locations_select on public.rider_locations
  for select to authenticated
  using (
    rider_id = auth.uid()
    or public.is_admin()
    or public.is_my_active_rider(public.rider_locations.rider_id)
  );

drop policy if exists rider_locations_write on public.rider_locations;
create policy rider_locations_write on public.rider_locations
  for all to authenticated
  using (rider_id = auth.uid())
  with check (rider_id = auth.uid());

-- ---------------------------------------------------------------------------
-- bookings  (reads only; every mutation goes through an RPC)
-- ---------------------------------------------------------------------------
drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select to authenticated
  using (
    customer_id = auth.uid()
    or rider_id = auth.uid()
    or public.is_admin()
    -- A rider must be able to read a booking they have been offered, including
    -- after the offer closes so their history stays readable.
    or public.was_offered_to_me(public.bookings.id)
  );

-- ---------------------------------------------------------------------------
-- booking_dispatches
-- ---------------------------------------------------------------------------
drop policy if exists booking_dispatches_select on public.booking_dispatches;
create policy booking_dispatches_select on public.booking_dispatches
  for select to authenticated
  using (
    rider_id = auth.uid()
    or public.is_admin()
    or public.owns_booking(public.booking_dispatches.booking_id)
  );

-- ---------------------------------------------------------------------------
-- booking_events
-- ---------------------------------------------------------------------------
drop policy if exists booking_events_select on public.booking_events;
create policy booking_events_select on public.booking_events
  for select to authenticated
  using (
    public.is_admin()
    or public.is_booking_party(public.booking_events.booking_id)
  );

-- Policies are evaluated as the querying role, so it needs EXECUTE on these.
grant execute on function
  public.shares_live_booking(uuid),
  public.has_live_offer_from(uuid),
  public.is_my_active_rider(uuid),
  public.was_offered_to_me(uuid),
  public.owns_booking(uuid),
  public.is_booking_party(uuid)
  to authenticated;


-- ---------------------------------------------------------------------------
-- Verify: this must return a row, and must not raise.
-- ---------------------------------------------------------------------------
select 'RLS recursion fix applied' as status,
       count(*) filter (where polname like '%_select') as select_policies_rebuilt
from pg_policy
where polrelid in (
  'public.profiles'::regclass, 'public.riders'::regclass,
  'public.vehicles'::regclass, 'public.rider_locations'::regclass,
  'public.bookings'::regclass, 'public.booking_dispatches'::regclass,
  'public.booking_events'::regclass
);
