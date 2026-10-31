-- =============================================================================
-- Ride App - DIAGNOSE "it isn't working"
--
-- Run this whole file in the Supabase SQL editor. It returns ONE table that
-- says, in plain language, what is wrong and what to do about it.
--
-- Unlike verify.sql (which only checks that objects exist), this actually
-- *simulates an authenticated user* and reads through the real RLS policies,
-- so it catches the recursion bug and anything like it.
-- =============================================================================

create or replace function public.diagnose()
returns table (n integer, status text, area text, detail text, fix text)
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_user     uuid;
  v_err      text;
  v_count    integer;
  v_riders   integer;
  v_online   integer;
  v_vehicled integer;
  v_fresh    integer;
  v_stale    integer;
begin
  create table if not exists public._diag (
    n integer, status text, area text, detail text, fix text
  );
  delete from public._diag;

  -- ---------------------------------------------------------------- 1
  insert into public._diag values (
    1,
    case when exists (select 1 from pg_proc
                      where proname = 'shares_live_booking'
                        and pronamespace = 'public'::regnamespace)
         then 'OK' else 'BROKEN' end,
    'RLS recursion fix',
    case when exists (select 1 from pg_proc
                      where proname = 'shares_live_booking'
                        and pronamespace = 'public'::regnamespace)
         then 'Helper functions are installed.'
         else 'The SECURITY DEFINER helpers are missing, so the policies still reference each other in a cycle. NOTHING works for a signed-in user.' end,
    case when exists (select 1 from pg_proc
                      where proname = 'shares_live_booking'
                        and pronamespace = 'public'::regnamespace)
         then ''
         else 'Run supabase/fix_rls_recursion.sql in the SQL editor. This is almost certainly your problem.' end
  );

  -- ---------------------------------------------------------------- 2
  -- Actually read through the policies as a real signed-in user.
  select id into v_user from public.profiles order by created_at limit 1;

  if v_user is null then
    insert into public._diag values (
      2, 'WARN', 'accounts',
      'No profiles exist yet, so the policies could not be exercised.',
      'Register an account at /register first.');
  else
    begin
      perform set_config(
        'request.jwt.claims',
        json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
      set local role authenticated;

      -- This is the exact read that failed on sign-in.
      select count(*) into v_count from public.profiles;
      select count(*) into v_count from public.bookings;
      select count(*) into v_count from public.booking_dispatches;
      select count(*) into v_count from public.rider_locations;

      reset role;
      perform set_config('request.jwt.claims', '', true);

      insert into public._diag values (
        2, 'OK', 'policy evaluation',
        'Signed-in reads of profiles, bookings, dispatches and locations all succeed.',
        '');
    exception when others then
      v_err := sqlerrm;
      begin reset role; exception when others then null; end;
      perform set_config('request.jwt.claims', '', true);
      insert into public._diag values (
        2, 'BROKEN', 'policy evaluation',
        'Reading as a signed-in user fails: ' || v_err,
        'If this mentions infinite recursion, run supabase/fix_rls_recursion.sql.');
    end;
  end if;

  -- ---------------------------------------------------------------- 3
  insert into public._diag values (
    3,
    case when exists (select 1 from cron.job where jobname = 'ride-dispatch-tick' and active)
         then 'OK' else 'BROKEN' end,
    'dispatch clock',
    case when exists (select 1 from cron.job where jobname = 'ride-dispatch-tick' and active)
         then 'pg_cron is advancing dispatch every 5 seconds.'
         else 'No active ride-dispatch-tick job. Offers will never time out; a booking will sit on the first rider forever.' end,
    case when exists (select 1 from cron.job where jobname = 'ride-dispatch-tick' and active)
         then ''
         else 'Enable pg_cron under Database -> Extensions, then re-run migration 0006.' end
  );

  -- ---------------------------------------------------------------- 4
  -- Why no rider is being matched. This is the usual cause of "not booking".
  select count(*) into v_riders from public.riders;
  select count(*) into v_online from public.riders where availability = 'online' and is_active;
  select count(*) into v_vehicled
    from public.riders r
    where r.availability = 'online' and r.is_active
      and exists (select 1 from public.vehicles v where v.rider_id = r.id);
  select count(*) into v_fresh
    from public.riders r
    join public.rider_locations rl on rl.rider_id = r.id
    where r.availability = 'online' and r.is_active
      and rl.last_seen > now() - make_interval(secs => public.app_setting_int('gps_stale_seconds', 45));

  insert into public._diag values (
    4,
    case when v_riders = 0 then 'BROKEN' else 'OK' end,
    'riders exist',
    v_riders || ' rider account(s).',
    case when v_riders = 0
         then 'Register an account at /register and choose "I drive".' else '' end);

  insert into public._diag values (
    5,
    case when v_online = 0 then 'BROKEN' else 'OK' end,
    'riders online',
    v_online || ' of ' || v_riders || ' rider(s) are online and active.',
    case when v_online = 0
         then 'Open /rider and flip the toggle to online. If it refuses, the GPS fix was rejected - see row 8.'
         else '' end);

  insert into public._diag values (
    6,
    case when v_online > 0 and v_vehicled = 0 then 'BROKEN'
         when v_online = 0 then 'SKIP' else 'OK' end,
    'riders have a vehicle',
    v_vehicled || ' online rider(s) have a vehicle registered.',
    case when v_online > 0 and v_vehicled = 0
         then 'find_nearby_riders filters on vehicle class. A rider with no vehicle row is NEVER matched. Admin -> Riders -> Edit -> set a plate number.'
         else '' end);

  insert into public._diag values (
    7,
    case when v_online > 0 and v_fresh = 0 then 'BROKEN'
         when v_online = 0 then 'SKIP' else 'OK' end,
    'rider GPS is fresh',
    v_fresh || ' online rider(s) reported a position in the last '
      || public.app_setting_int('gps_stale_seconds', 45) || 's.',
    case when v_online > 0 and v_fresh = 0
         then 'Stale riders are skipped by dispatch. Keep the /rider tab open and in the foreground; phones stop GPS when the screen locks.'
         else '' end);

  -- ---------------------------------------------------------------- 8
  insert into public._diag values (
    8,
    'INFO',
    'GPS accuracy limit',
    'update_rider_location rejects fixes less precise than '
      || public.app_setting_int('gps_max_accuracy_m', 10000) || ' m. '
      || 'Laptops positioning by Wi-Fi often report 1000-50000 m.',
    'If going online fails with "GPS signal is too weak", raise it: '
      || 'select public.admin_set_setting(''gps_max_accuracy_m'', ''50000''::jsonb);');

  -- ---------------------------------------------------------------- 9
  select count(*) into v_count from public.bookings;
  select count(*) into v_stale from public.bookings where status = 'searching';

  insert into public._diag values (
    9, 'INFO', 'bookings',
    v_count || ' booking(s) total, ' || v_stale || ' currently searching.',
    case when v_stale > 0
         then 'Still searching? Check rows 3-7. Inspect with: select * from booking_events where booking_id = ''<id>'' order by created_at;'
         else '' end);

  -- ---------------------------------------------------------------- 10
  insert into public._diag values (
    10,
    case when (select count(*) from pg_publication_tables
               where pubname = 'supabase_realtime'
                 and tablename in ('bookings','booking_dispatches','rider_locations','notifications','riders')) = 5
         then 'OK' else 'BROKEN' end,
    'realtime',
    (select count(*) from pg_publication_tables
      where pubname = 'supabase_realtime'
        and tablename in ('bookings','booking_dispatches','rider_locations','notifications','riders'))
      || ' of 5 tables published.',
    'If below 5, live updates will not arrive. Re-run migration 0006.');

  return query select d.n, d.status, d.area, d.detail, d.fix
               from public._diag d order by d.n;
end;
$fn$;

revoke all on function public.diagnose() from public, anon, authenticated;

-- =============================================================================
select * from public.diagnose();
-- =============================================================================
