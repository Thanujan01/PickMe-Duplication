-- =============================================================================
-- 0005  Row Level Security
--
-- Principle: the frontend is a rendering layer. Everything that matters is
-- enforced here. All writes to bookings / dispatches / rider state go through
-- the SECURITY DEFINER functions in 0004 - the tables themselves grant no
-- INSERT or UPDATE to end users.
-- =============================================================================

alter table public.profiles           enable row level security;
alter table public.riders             enable row level security;
alter table public.vehicles           enable row level security;
alter table public.rider_locations    enable row level security;
alter table public.bookings           enable row level security;
alter table public.booking_dispatches enable row level security;
alter table public.booking_events     enable row level security;
alter table public.notifications      enable row level security;
alter table public.device_tokens      enable row level security;
alter table public.admin_settings     enable row level security;

-- ---------------------------------------------------------------------------
-- Column-level guards that RLS cannot express.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is NULL only outside a browser session (SQL editor, migrations,
  -- SECURITY DEFINER internals). Those are already trusted.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  -- Privilege escalation and self-unblocking are not negotiable.
  if new.role is distinct from old.role then
    raise exception 'role_change_forbidden';
  end if;
  if new.is_blocked is distinct from old.is_blocked then
    raise exception 'block_change_forbidden';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- public.riders holds platform-owned state: availability, is_active, rating,
-- total_rides. Rather than policing individual columns in a trigger, the table
-- simply grants no UPDATE to browser roles - every change goes through a
-- SECURITY DEFINER function (set_rider_availability, accept_booking,
-- advance_booking_status, admin_set_rider_active, update_rider_profile).
drop trigger if exists riders_guard on public.riders;
drop function if exists public.guard_rider_update();

-- The one rider-editable field on the table.
create or replace function public.update_rider_profile(p_license_number text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  update public.riders
     set license_number = nullif(p_license_number, '')
   where id = auth.uid();
  if not found then raise exception 'not_a_rider'; end if;
end;
$$;

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

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- No UPDATE policy: read receipts go through mark_notifications_read() so a
-- client cannot rewrite a notification's contents.
drop policy if exists notifications_update_own on public.notifications;

drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- device_tokens
-- ---------------------------------------------------------------------------
drop policy if exists device_tokens_own on public.device_tokens;
create policy device_tokens_own on public.device_tokens
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- admin_settings
--
-- Clients need a handful of tunables (the countdown length, fare parameters).
-- Everything else - notably the push relay credentials - stays server-side.
-- ---------------------------------------------------------------------------
drop policy if exists admin_settings_select on public.admin_settings;
create policy admin_settings_select on public.admin_settings
  for select to authenticated
  using (
    key in (
      'dispatch_window_seconds',
      'dispatch_radius_m',
      'gps_stale_seconds',
      'search_timeout_seconds',
      'max_dispatch_attempts',
      'fare_base',
      'fare_per_km',
      'fare_per_min',
      'allow_customer_cancel_after_accept'
    )
  );
-- Writes are admin-only and go through admin_set_setting().

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, anon;

grant select on public.profiles, public.riders, public.vehicles,
                 public.rider_locations, public.bookings,
                 public.booking_dispatches, public.booking_events,
                 public.notifications, public.device_tokens,
                 public.admin_settings
  to authenticated;

grant insert, update on public.profiles                 to authenticated;
grant insert, update, delete on public.vehicles          to authenticated;
grant insert, update on public.rider_locations           to authenticated;
grant delete on public.notifications                     to authenticated;
grant insert, update, delete on public.device_tokens     to authenticated;
-- NB: public.bookings, public.booking_dispatches, public.booking_events and
-- public.riders intentionally receive no write grant.

-- Internal plumbing must never be callable from a browser.
--
-- IMPORTANT: Postgres grants EXECUTE on every new function to PUBLIC, and both
-- `anon` and `authenticated` inherit that. Revoking from those two roles alone
-- leaves the PUBLIC grant in place and the function still reachable over
-- PostgREST, so PUBLIC must be revoked explicitly.
revoke all on function public.dispatch_tick()
  from public, anon, authenticated;
revoke all on function public.offer_next_rider(uuid)
  from public, anon, authenticated;
revoke all on function public.fail_booking_no_rider(uuid, text)
  from public, anon, authenticated;
revoke all on function public.push_notification(uuid, notification_type, text, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.relay_push(uuid)
  from public, anon, authenticated;
revoke all on function public.log_booking_event(uuid, text, booking_status, booking_status, jsonb, uuid)
  from public, anon, authenticated;

grant execute on function
  public.shares_live_booking(uuid),
  public.has_live_offer_from(uuid),
  public.is_my_active_rider(uuid),
  public.was_offered_to_me(uuid),
  public.owns_booking(uuid),
  public.is_booking_party(uuid)
  to authenticated;

grant execute on function
  public.create_booking(double precision, double precision, text,
                        double precision, double precision, text,
                        integer, integer, text, text),
  public.accept_booking(uuid),
  public.reject_booking(uuid),
  public.cancel_booking(uuid, text),
  public.advance_booking_status(uuid, booking_status),
  public.retry_booking_dispatch(uuid),
  public.update_rider_location(double precision, double precision,
                               double precision, double precision, double precision),
  public.set_rider_availability(rider_availability),
  public.find_nearby_riders(uuid, integer),
  public.rider_dashboard_stats(),
  public.admin_dashboard_stats(),
  public.admin_assign_rider(uuid, uuid),
  public.admin_set_rider_active(uuid, boolean),
  public.admin_set_setting(text, jsonb),
  public.mark_notifications_read(uuid[]),
  public.update_rider_profile(text),
  public.register_device_token(text, text),
  public.is_admin(),
  public.is_privileged(),
  public.current_user_role()
  to authenticated;
