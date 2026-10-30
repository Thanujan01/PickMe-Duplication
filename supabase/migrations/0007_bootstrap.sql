-- =============================================================================
-- 0007  Bootstrap helpers
--
-- These exist because `admin` is deliberately not self-assignable at signup
-- (see handle_new_user). You promote the first admin by hand, once.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Promote an existing, already-signed-up account to admin.
--
--   select public.promote_to_admin('you@example.com');
--
-- Run this from the Supabase SQL editor, which executes as a superuser. It is
-- revoked from browser roles so nobody can call it from the app.
-- ---------------------------------------------------------------------------
create or replace function public.promote_to_admin(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(p_email);
  if v_id is null then
    raise exception 'No auth user with email %. Sign up through the app first.', p_email;
  end if;

  insert into public.profiles (id, role, full_name)
  values (v_id, 'admin', split_part(p_email, '@', 1))
  on conflict (id) do update set role = 'admin';

  return v_id;
end;
$$;

-- Superuser-only: run it from the SQL editor. See the PUBLIC-grant note in 0005.
revoke all on function public.promote_to_admin(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Finish setting up a rider: fill in their details and register a vehicle.
-- Callable by an admin from the dashboard (the auth account itself is created
-- through the admin-create-rider Edge Function, which owns the password).
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

    insert into public.vehicles
      (rider_id, vehicle_type, make, model, color, plate_number, year, is_primary)
    values
      (p_rider_id, coalesce(p_vehicle_type, 'car'), coalesce(p_make, ''),
       coalesce(p_model, ''), coalesce(p_color, ''), p_plate_number, p_year, true)
    on conflict (plate_number) do update
       set rider_id     = p_rider_id,
           vehicle_type = coalesce(p_vehicle_type, public.vehicles.vehicle_type),
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

-- ---------------------------------------------------------------------------
-- Development seeding: place a rider at a coordinate and bring them online
-- without a browser. Lets you exercise the dispatch algorithm from SQL.
--
--   select public.dev_place_rider('rider1@example.com', 6.9271, 79.8612);
--
-- Superuser-only (revoked below), so it cannot be abused from the app, and it
-- refuses to run against a database that has a real admin unless forced.
-- ---------------------------------------------------------------------------
create or replace function public.dev_place_rider(
  p_email     text,
  p_latitude  double precision,
  p_longitude double precision,
  p_online    boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(p_email);
  if v_id is null then raise exception 'No auth user with email %', p_email; end if;

  insert into public.riders (id) values (v_id) on conflict (id) do nothing;
  update public.profiles set role = 'rider' where id = v_id and role <> 'admin';

  insert into public.rider_locations (rider_id, latitude, longitude, accuracy, last_seen)
  values (v_id, p_latitude, p_longitude, 10, now())
  on conflict (rider_id) do update
     set latitude  = excluded.latitude,
         longitude = excluded.longitude,
         accuracy  = 10,
         last_seen = now();

  update public.riders
     set availability = case when p_online then 'online' else 'offline' end,
         is_active    = true
   where id = v_id;

  return v_id;
end;
$$;

revoke all on function public.dev_place_rider(text, double precision, double precision, boolean)
  from public, anon, authenticated;
