-- =============================================================================
-- 0009  Single vehicle class: bus
--
-- The platform runs buses only, so the car/bike/tuk/van choice is gone. Making
-- it a one-value constraint rather than deleting the column keeps
-- find_nearby_riders' vehicle-class matching intact and leaves room to add
-- classes back later without another schema change.
--
-- Existing rows are migrated before the constraints are tightened, so this is
-- safe to run on a database that already has data.
-- =============================================================================

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
