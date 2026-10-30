-- =============================================================================
-- 0003  Helper functions and triggers
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Settings accessor. Reads admin_settings with a fallback so the platform keeps
-- working if a key is ever deleted.
-- ---------------------------------------------------------------------------
create or replace function public.app_setting_int(p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::integer from public.admin_settings where key = p_key), p_default);
$$;

create or replace function public.app_setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::boolean from public.admin_settings where key = p_key), p_default);
$$;

create or replace function public.app_setting_num(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::numeric from public.admin_settings where key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so that RLS policies on `profiles` can call
-- them without recursing into their own policy.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_rider()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'rider');
$$;

/**
 * Trusted caller check for the admin_* functions.
 *
 * `is_admin()` alone is not enough, because it reads auth.uid() and there are
 * three legitimate privileged callers:
 *
 *   1. a signed-in administrator in the browser  -> is_admin()
 *   2. an Edge Function using the service-role key -> JWT role = 'service_role'
 *   3. a direct database connection (SQL editor, migrations, pg_cron)
 *      -> no request.jwt.claims at all
 *
 * An anonymous or ordinary signed-in browser request always carries JWT claims
 * with role 'anon' or 'authenticated', so neither can satisfy case 2 or 3.
 */
create or replace function public.is_privileged()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    nullif(current_setting('request.jwt.claims', true), '') is null
    or coalesce(
         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
         ''
       ) = 'service_role'
    or public.is_admin();
$$;

-- Statuses in which a booking is "live" - the rider is en route or driving.
create or replace function public.live_booking_statuses()
returns booking_status[]
language sql
immutable
as $$
  select array['assigned', 'rider_arriving', 'arrived', 'in_progress']::booking_status[];
$$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists riders_touch on public.riders;
create trigger riders_touch before update on public.riders
  for each row execute function public.touch_updated_at();

drop trigger if exists vehicles_touch on public.vehicles;
create trigger vehicles_touch before update on public.vehicles
  for each row execute function public.touch_updated_at();

drop trigger if exists bookings_touch on public.bookings;
create trigger bookings_touch before update on public.bookings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- New auth user -> profile (+ rider row when signing up as a rider).
-- Role comes from the signup metadata but 'admin' is never self-assignable.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_requested text;
begin
  v_requested := coalesce(new.raw_user_meta_data ->> 'role', 'customer');

  -- Self-service signup can only ever create a customer or a rider.
  if v_requested = 'rider' then
    v_role := 'rider';
  else
    v_role := 'customer';
  end if;

  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    v_role,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;

  if v_role = 'rider' then
    insert into public.riders (id) values (new.id) on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the riders row in step if an admin promotes a profile to rider.
create or replace function public.sync_rider_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'rider' then
    insert into public.riders (id) values (new.id) on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_sync_rider on public.profiles;
create trigger profiles_sync_rider after insert or update of role on public.profiles
  for each row execute function public.sync_rider_row();

-- ---------------------------------------------------------------------------
-- Geography columns are derived, never written by clients.
-- ---------------------------------------------------------------------------
create or replace function public.sync_rider_location_geo()
returns trigger
language plpgsql
as $$
begin
  new.location   := st_setsrid(st_makepoint(new.longitude, new.latitude), 4326)::geography;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists rider_locations_geo on public.rider_locations;
create trigger rider_locations_geo before insert or update on public.rider_locations
  for each row execute function public.sync_rider_location_geo();

create or replace function public.sync_booking_geo()
returns trigger
language plpgsql
as $$
begin
  new.pickup_location :=
    st_setsrid(st_makepoint(new.pickup_longitude, new.pickup_latitude), 4326)::geography;
  new.destination_location :=
    st_setsrid(st_makepoint(new.destination_longitude, new.destination_latitude), 4326)::geography;
  return new;
end;
$$;

drop trigger if exists bookings_geo on public.bookings;
create trigger bookings_geo before insert or update of
  pickup_latitude, pickup_longitude, destination_latitude, destination_longitude
  on public.bookings
  for each row execute function public.sync_booking_geo();

-- ---------------------------------------------------------------------------
-- Audit + notification writers (internal; called by the dispatch functions)
-- ---------------------------------------------------------------------------
create or replace function public.log_booking_event(
  p_booking_id uuid,
  p_event_type text,
  p_from       booking_status default null,
  p_to         booking_status default null,
  p_metadata   jsonb default '{}'::jsonb,
  p_actor      uuid default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.booking_events (booking_id, actor_id, event_type, from_status, to_status, metadata)
  values (p_booking_id, coalesce(p_actor, auth.uid()), p_event_type, p_from, p_to, p_metadata);
$$;

create or replace function public.push_notification(
  p_user_id    uuid,
  p_type       notification_type,
  p_title      text,
  p_body       text default '',
  p_booking_id uuid default null,
  p_data       jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_user_id is null then
    return null;
  end if;

  insert into public.notifications (user_id, type, title, body, booking_id, data)
  values (p_user_id, p_type, p_title, p_body, p_booking_id, p_data)
  returning id into v_id;

  -- Optional server-side web push relay. Only fires when an admin has set the
  -- `fcm_relay_url` setting AND pg_net is installed. Wrapped so that a push
  -- failure can never roll back a booking transaction.
  begin
    perform public.relay_push(v_id);
  exception when others then
    null;
  end;

  return v_id;
end;
$$;

-- Fire-and-forget hand-off to the push-notify Edge Function. No-op unless
-- configured; see README "Push notifications".
create or replace function public.relay_push(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_url text;
  v_key text;
begin
  select value #>> '{}' into v_url from public.admin_settings where key = 'fcm_relay_url';
  select value #>> '{}' into v_key from public.admin_settings where key = 'fcm_relay_key';

  if v_url is null or v_url = '' then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object('notification_id', p_notification_id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(v_key, '')
    )
  );
end;
$$;
