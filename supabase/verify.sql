-- =============================================================================
-- Ride App - health check
--
-- Run this in the Supabase SQL editor after setup_all.sql. It returns ONE
-- result set, so nothing is hidden the way it is when a script ends with
-- several separate selects.
--
-- Every row must say PASS before the app can work.
-- =============================================================================

with expected_tables(name) as (
  values ('profiles'), ('riders'), ('vehicles'), ('rider_locations'), ('bookings'),
         ('booking_dispatches'), ('booking_events'), ('notifications'),
         ('device_tokens'), ('admin_settings')
),
expected_functions(name) as (
  values ('create_booking'), ('offer_next_rider'), ('accept_booking'),
         ('reject_booking'), ('dispatch_tick'), ('cancel_booking'),
         ('advance_booking_status'), ('find_nearby_riders'),
         ('retry_booking_dispatch'), ('update_rider_location'),
         ('set_rider_availability'), ('promote_to_admin')
),
realtime_tables(name) as (
  values ('bookings'), ('booking_dispatches'), ('rider_locations'),
         ('notifications'), ('riders')
),
checks as (
  select 1 as n, 'PostGIS installed' as item,
         (select count(*) from pg_extension where extname = 'postgis') as found,
         1 as needed,
         'Database -> Extensions -> enable postgis' as fix

  union all
  select 2, 'pg_cron installed',
         (select count(*) from pg_extension where extname = 'pg_cron'), 1,
         'Database -> Extensions -> enable pg_cron'

  union all
  -- The single most important row: without this, offers never time out and
  -- dispatch stalls on the first rider forever.
  select 3, 'DISPATCH CLOCK scheduled',
         (select count(*) from cron.job where jobname = 'ride-dispatch-tick' and active), 1,
         'Re-run migration 0006 after enabling pg_cron'

  union all
  select 4, 'tables created',
         (select count(*) from information_schema.tables t
           join expected_tables e on e.name = t.table_name
          where t.table_schema = 'public'), 10,
         'Re-run setup_all.sql'

  union all
  select 5, 'tables with RLS enabled',
         (select count(*) from pg_class c
           join expected_tables e on e.name = c.relname
          where c.relnamespace = 'public'::regnamespace
            and c.relkind = 'r' and c.relrowsecurity), 10,
         'Re-run migration 0005'

  union all
  select 6, 'dispatch functions present',
         (select count(distinct p.proname) from pg_proc p
           join expected_functions e on e.name = p.proname
          where p.pronamespace = 'public'::regnamespace), 12,
         'Re-run migrations 0004 and 0007'

  union all
  select 7, 'Realtime publishing',
         (select count(*) from pg_publication_tables pt
           join realtime_tables r on r.name = pt.tablename
          where pt.pubname = 'supabase_realtime'), 5,
         'Re-run migration 0006'

  union all
  select 8, 'signup trigger',
         (select count(*) from pg_trigger where tgname = 'on_auth_user_created'), 1,
         'Re-run migration 0003'

  union all
  select 9, 'settings seeded',
         (select count(*) from public.admin_settings), 9,
         'Re-run migration 0002'

  union all
  -- Proves PostGIS resolves from inside a pinned search_path, which is the
  -- exact thing that failed with 42704 before.
  select 10, 'geography type reachable in functions',
         (select count(*) from pg_proc
           where proname = 'find_nearby_riders'
             and pronamespace = 'public'::regnamespace
             and 'search_path=public, extensions' = any(proconfig)), 1,
         'Re-run migration 0004'
)
select
  n,
  case when found >= needed then 'PASS' else 'FAIL' end as result,
  item,
  found || ' / ' || needed as count,
  case when found >= needed then '' else fix end as how_to_fix
from checks
order by n;
