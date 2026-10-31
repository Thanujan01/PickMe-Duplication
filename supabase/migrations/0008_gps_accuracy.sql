-- =============================================================================
-- 0008  Make the GPS accuracy limit configurable, and raise the default
--
-- update_rider_location hard-coded a 2000 m rejection threshold. That is a
-- sensible number for a phone (5-50 m typical) but wrong for anything else:
-- a laptop positioning by Wi-Fi routinely reports 1000-50000 m, so testing on
-- a desktop failed with `accuracy_too_low` and the rider could never go
-- online. The limit is now a setting, and the error reports the actual value
-- so the cause is obvious instead of mysterious.
--
-- Tighten it for production once real riders are on phones:
--   select public.admin_set_setting('gps_max_accuracy_m', '200'::jsonb);
-- =============================================================================

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
