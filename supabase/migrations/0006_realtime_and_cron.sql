-- =============================================================================
-- 0006  Realtime publication + the server-side dispatch clock
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Realtime
--
-- REPLICA IDENTITY FULL makes the previous row available to the Realtime
-- server, which it needs in order to evaluate RLS on UPDATE and DELETE events.
-- Without it, a customer's filtered subscription silently misses updates.
-- ---------------------------------------------------------------------------
alter table public.bookings           replica identity full;
alter table public.booking_dispatches replica identity full;
alter table public.rider_locations    replica identity full;
alter table public.notifications      replica identity full;
alter table public.riders             replica identity full;

do $$
declare
  t text;
begin
  foreach t in array array[
    'bookings', 'booking_dispatches', 'rider_locations', 'notifications', 'riders'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;   -- already published
      when undefined_object then null;   -- publication absent (local bootstrap)
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- THE DISPATCH CLOCK
--
-- Spec section 7 requires a reliable server-side scheduler for the 10-second
-- offer windows and explicitly forbids a frontend timer. pg_cron supports
-- sub-minute schedules, so the clock lives inside the database next to the
-- data it guards - no extra service, no always-on worker, free tier.
--
-- The tick only reaps deadlines that are already recorded in
-- booking_dispatches.expires_at, so a late or duplicated run is harmless.
-- ---------------------------------------------------------------------------
do $$
begin
  -- Remove any previous definition so this migration is re-runnable.
  perform cron.unschedule('ride-dispatch-tick');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.schedule('ride-dispatch-tick', '5 seconds', 'select public.dispatch_tick();');
exception when others then
  raise warning
    'Could not schedule ride-dispatch-tick (%). Enable pg_cron under Database -> Extensions, or drive the dispatch-tick Edge Function from an external cron. See README.',
    sqlerrm;
end $$;

-- Nightly housekeeping: trim resolved offers and read notifications so the
-- free-tier database stays small. Keeps booking_events (the audit trail).
do $$
begin
  perform cron.unschedule('ride-nightly-cleanup');
exception when others then
  null;
end $$;

create or replace function public.nightly_cleanup()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.booking_dispatches
   where status <> 'pending' and offered_at < now() - interval '30 days';

  delete from public.notifications
   where read_at is not null and created_at < now() - interval '30 days';

  delete from public.device_tokens
   where last_used_at < now() - interval '90 days';
$$;

revoke all on function public.nightly_cleanup() from public, anon, authenticated;

do $$
begin
  perform cron.schedule('ride-nightly-cleanup', '17 3 * * *', 'select public.nightly_cleanup();');
exception when others then
  null;
end $$;
