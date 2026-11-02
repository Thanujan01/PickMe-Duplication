-- =============================================================================
-- Ride App - APPLY ALL FIXES
--
-- Run this whole file in the Supabase SQL editor. Idempotent and safe to
-- re-run. It applies two fixes to a database created before 2026-10-31:
--
--   1. RLS infinite recursion
--      Symptom: "infinite recursion detected in policy for relation
--      "bookings"" on sign-in. profiles -> bookings -> booking_dispatches
--      -> bookings formed a cycle, because Postgres evaluates the policy of
--      every table a policy references. Every cross-table check now lives in
--      a SECURITY DEFINER helper, which does not re-trigger RLS.
--
--   3. Multiple vehicle classes
--      The platform runs buses only. car/bike/tuk/van are gone; existing rows
--      are migrated to 'bus' before the constraint is tightened.
--
--   2. GPS accuracy limit too strict
--      Symptom: a rider cannot go online; "GPS signal is too weak".
--      update_rider_location rejected anything less precise than 2000 m,
--      but a laptop positioning by Wi-Fi reports 1000-50000 m. The limit is
--      now the `gps_max_accuracy_m` setting (default 10000) and the error
--      states the actual reading.
--
-- Both are already in migrations 0005 and 0008 for fresh installs.
--
-- Afterwards run supabase/diagnose.sql to confirm.
-- =============================================================================


-- #############################################################################
-- ## 1. RLS recursion
-- #############################################################################

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


-- Policies are evaluated as the querying role, so it needs EXECUTE on these.
grant execute on function
  public.shares_live_booking(uuid),
  public.has_live_offer_from(uuid),
  public.is_my_active_rider(uuid),
  public.was_offered_to_me(uuid),
  public.owns_booking(uuid),
  public.is_booking_party(uuid)
  to authenticated;


-- #############################################################################
-- ## 2. GPS accuracy limit
-- #############################################################################

insert into public.admin_settings (key, value, label) values
  ('gps_max_accuracy_m', '10000'::jsonb,
   'Reject GPS fixes less precise than this many metres')
on conflict (key) do nothing;

create or replace function public.update_rider_location(
  p_latitude  double precision,
  p_longitude double precision,
  p_heading   double precision default null,
  p_speed     double precision default null,
  p_accuracy  double precision default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_max integer := public.app_setting_int('gps_max_accuracy_m', 10000);
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from public.riders where id = v_uid) then
    raise exception 'not_a_rider';
  end if;

  -- Validation: reject physically impossible or hopelessly imprecise fixes
  -- rather than poisoning the dispatch ranking with them.
  if p_latitude is null or p_longitude is null then raise exception 'invalid_coordinates'; end if;
  if p_latitude  not between -90  and 90  then raise exception 'invalid_coordinates'; end if;
  if p_longitude not between -180 and 180 then raise exception 'invalid_coordinates'; end if;

  if p_accuracy is not null and p_accuracy > v_max then
    -- DETAIL carries the numbers so the UI can explain itself.
    raise exception 'accuracy_too_low'
      using detail = format('reported %s m, limit %s m', round(p_accuracy::numeric), v_max);
  end if;

  insert into public.rider_locations as rl
    (rider_id, latitude, longitude, heading, speed, accuracy, last_seen)
  values
    (v_uid, p_latitude, p_longitude,
     case when p_heading between 0 and 359.999 then p_heading end,
     greatest(p_speed, 0), p_accuracy, v_now)
  on conflict (rider_id) do update set
    latitude  = excluded.latitude,
    longitude = excluded.longitude,
    heading   = coalesce(excluded.heading, rl.heading),
    speed     = excluded.speed,
    accuracy  = excluded.accuracy,
    last_seen = v_now;

  return v_now;
end;
$$;

grant execute on function public.update_rider_location(
  double precision, double precision, double precision, double precision, double precision
) to authenticated;

-- Allow the client to read the new key so the rider screen can explain the
-- limit before a write is attempted.
drop policy if exists admin_settings_select on public.admin_settings;
create policy admin_settings_select on public.admin_settings
  for select to authenticated
  using (
    key in (
      'dispatch_window_seconds',
      'dispatch_radius_m',
      'gps_stale_seconds',
      'gps_max_accuracy_m',
      'search_timeout_seconds',
      'max_dispatch_attempts',
      'fare_base',
      'fare_per_km',
      'fare_per_min',
      'allow_customer_cancel_after_accept'
    )
  );


-- #############################################################################
-- ## 3. Buses only
-- #############################################################################

-- ---------------------------------------------------------------------------
-- Migrate existing data first - otherwise the new CHECK would reject it.
-- ---------------------------------------------------------------------------
update public.vehicles set vehicle_type = 'bus' where vehicle_type <> 'bus';
update public.bookings set vehicle_type = 'bus' where vehicle_type <> 'bus';

-- ---------------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------------
alter table public.vehicles
  drop constraint if exists vehicles_vehicle_type_check;

alter table public.vehicles
  alter column vehicle_type set default 'bus';

alter table public.vehicles
  add constraint vehicles_vehicle_type_check check (vehicle_type = 'bus');

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------
alter table public.bookings
  drop constraint if exists bookings_vehicle_type_check;

alter table public.bookings
  alter column vehicle_type set default 'bus';

alter table public.bookings
  add constraint bookings_vehicle_type_check check (vehicle_type = 'bus');

-- ---------------------------------------------------------------------------
-- create_booking: default the parameter to 'bus', and ignore anything else a
-- stale client might still send rather than failing the booking.
-- ---------------------------------------------------------------------------
create or replace function public.create_booking(
  p_pickup_lat         double precision,
  p_pickup_lng         double precision,
  p_pickup_address     text,
  p_dest_lat           double precision,
  p_dest_lng           double precision,
  p_dest_address       text,
  p_estimated_distance integer default null,
  p_estimated_duration integer default null,
  p_vehicle_type       text    default 'bus',
  p_idempotency_key    text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_profile    public.profiles;
  v_booking_id uuid;
  v_timeout    integer := public.app_setting_int('search_timeout_seconds', 180);
  v_fare       numeric;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then raise exception 'profile_missing'; end if;
  if v_profile.is_blocked then raise exception 'account_blocked'; end if;
  if v_profile.role <> 'customer' then raise exception 'not_a_customer'; end if;

  if p_pickup_lat is null or p_pickup_lng is null
     or p_dest_lat is null or p_dest_lng is null then
    raise exception 'invalid_coordinates';
  end if;

  -- Idempotency: a retried request returns the booking it already made.
  if p_idempotency_key is not null then
    select id into v_booking_id
    from public.bookings
    where customer_id = v_uid and idempotency_key = p_idempotency_key;
    if v_booking_id is not null then
      return v_booking_id;
    end if;
  end if;

  if exists (
    select 1 from public.bookings
    where customer_id = v_uid
      and status in ('searching', 'assigned', 'rider_arriving', 'arrived', 'in_progress')
  ) then
    raise exception 'active_booking_exists';
  end if;

  -- Still recorded for operational reporting; no longer shown to anyone.
  v_fare := public.app_setting_num('fare_base', 150)
          + public.app_setting_num('fare_per_km', 70)  * (coalesce(p_estimated_distance, 0) / 1000.0)
          + public.app_setting_num('fare_per_min', 4)  * (coalesce(p_estimated_duration, 0) / 60.0);

  insert into public.bookings (
    customer_id,
    pickup_latitude, pickup_longitude, pickup_address,
    destination_latitude, destination_longitude, destination_address,
    estimated_distance, estimated_duration, estimated_fare,
    vehicle_type, status, search_expires_at, idempotency_key
  ) values (
    v_uid,
    p_pickup_lat, p_pickup_lng, coalesce(p_pickup_address, ''),
    p_dest_lat,   p_dest_lng,   coalesce(p_dest_address, ''),
    p_estimated_distance, p_estimated_duration, round(v_fare, 2),
    'bus', 'searching',
    now() + make_interval(secs => v_timeout),
    p_idempotency_key
  )
  returning id into v_booking_id;

  perform public.log_booking_event(
    v_booking_id, 'booking_created', null, 'searching',
    jsonb_build_object(
      'estimated_distance', p_estimated_distance,
      'estimated_duration', p_estimated_duration
    )
  );

  perform public.push_notification(
    v_uid, 'booking_created',
    'Looking for a bus',
    'We are contacting drivers near your pickup point.',
    v_booking_id
  );

  -- Kick off the sequential dispatch immediately; pg_cron advances it from here.
  perform public.offer_next_rider(v_booking_id);

  return v_booking_id;
end;
$$;

grant execute on function public.create_booking(
  double precision, double precision, text,
  double precision, double precision, text,
  integer, integer, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Any rider already registered keeps their vehicle row; it is now a bus.
-- ---------------------------------------------------------------------------
create or replace function public.admin_upsert_rider_details(
  p_rider_id       uuid,
  p_full_name      text default null,
  p_phone          text default null,
  p_license_number text default null,
  p_vehicle_type   text default null,
  p_make           text default null,
  p_model          text default null,
  p_color          text default null,
  p_plate_number   text default null,
  p_year           integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_privileged() then raise exception 'not_authorized'; end if;

  if not exists (select 1 from public.profiles where id = p_rider_id) then
    raise exception 'profile_missing';
  end if;

  update public.profiles
     set role      = 'rider',
         full_name = coalesce(nullif(p_full_name, ''), full_name),
         phone     = coalesce(nullif(p_phone, ''), phone)
   where id = p_rider_id;

  insert into public.riders (id, license_number)
  values (p_rider_id, p_license_number)
  on conflict (id) do update
     set license_number = coalesce(nullif(p_license_number, ''), public.riders.license_number);

  if p_plate_number is not null and p_plate_number <> '' then
    -- vehicles_one_primary_idx allows a single primary vehicle per rider, so
    -- demote any other one before inserting this as primary.
    update public.vehicles
       set is_primary = false
     where rider_id = p_rider_id
       and plate_number <> p_plate_number
       and is_primary;

    -- p_vehicle_type is accepted for call-compatibility but ignored: there is
    -- exactly one class now.
    insert into public.vehicles
      (rider_id, vehicle_type, make, model, color, plate_number, year, is_primary)
    values
      (p_rider_id, 'bus', coalesce(p_make, ''),
       coalesce(p_model, ''), coalesce(p_color, ''), p_plate_number, p_year, true)
    on conflict (plate_number) do update
       set rider_id     = p_rider_id,
           vehicle_type = 'bus',
           make         = coalesce(nullif(p_make, ''),  public.vehicles.make),
           model        = coalesce(nullif(p_model, ''), public.vehicles.model),
           color        = coalesce(nullif(p_color, ''), public.vehicles.color),
           year         = coalesce(p_year, public.vehicles.year),
           is_primary   = true;
  end if;

  return p_rider_id;
end;
$$;

grant execute on function public.admin_upsert_rider_details(
  uuid, text, text, text, text, text, text, text, text, integer
) to authenticated;


-- #############################################################################
-- ## Verify
-- #############################################################################

select
  (select count(*) from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('shares_live_booking','has_live_offer_from','is_my_active_rider',
                      'was_offered_to_me','owns_booking','is_booking_party')) as recursion_helpers,
  (select value #>> '{}' from public.admin_settings where key = 'gps_max_accuracy_m') as gps_max_accuracy_m,
  (select count(*) from public.vehicles where vehicle_type <> 'bus') as non_bus_vehicles,
  'expect 6, 10000, 0' as expected;
