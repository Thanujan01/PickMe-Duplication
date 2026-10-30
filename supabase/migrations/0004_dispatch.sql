-- =============================================================================
-- 0004  Booking lifecycle + sequential nearest-rider dispatch
--
-- Every function here is SECURITY DEFINER and derives the acting user from
-- auth.uid(). No function trusts a caller-supplied identity.
--
-- Errors are raised with short machine-readable codes as the message text so
-- the frontend can map them to copy. See src/features/booking/api.ts.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Rider presence
-- ---------------------------------------------------------------------------
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
  if p_accuracy is not null and p_accuracy > 2000 then raise exception 'accuracy_too_low'; end if;

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

create or replace function public.set_rider_availability(p_status rider_availability)
returns rider_availability
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_rider public.riders;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select * into v_rider from public.riders where id = v_uid for update;
  if not found then raise exception 'not_a_rider'; end if;
  if not v_rider.is_active then raise exception 'rider_deactivated'; end if;

  -- 'busy' is owned by the dispatcher, never set by a rider.
  if p_status = 'busy' then raise exception 'busy_is_system_managed'; end if;

  -- Cannot disappear mid-job.
  if p_status = 'offline' and exists (
    select 1 from public.bookings
    where rider_id = v_uid and status = any (public.live_booking_statuses())
  ) then
    raise exception 'has_active_booking';
  end if;

  -- Going online requires a usable, recent fix so dispatch never ranks a rider
  -- by a stale position.
  if p_status = 'online' then
    if not exists (
      select 1 from public.rider_locations
      where rider_id = v_uid
        and last_seen > now() - make_interval(secs => public.app_setting_int('gps_stale_seconds', 45))
    ) then
      raise exception 'location_required';
    end if;
  end if;

  update public.riders set availability = p_status where id = v_uid;
  return p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Candidate search (spec section 7 step 1 and 2)
--
-- Straight-line ranking over an index-backed ST_DWithin filter. Returns
-- candidates nearest-first, excluding every rider who is unavailable, stale,
-- busy, already offered this booking, or holding a live offer elsewhere.
-- ---------------------------------------------------------------------------
create or replace function public.find_nearby_riders(
  p_booking_id uuid,
  p_limit      integer default 20
)
returns table (rider_id uuid, distance_m double precision, last_seen timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pickup geography;
  v_type   text;
  v_radius integer := public.app_setting_int('dispatch_radius_m', 15000);
  v_stale  integer := public.app_setting_int('gps_stale_seconds', 45);
begin
  select b.pickup_location, b.vehicle_type
    into v_pickup, v_type
  from public.bookings b
  where b.id = p_booking_id;

  if v_pickup is null then
    return;
  end if;

  return query
  select r.id,
         st_distance(rl.location, v_pickup) as distance_m,
         rl.last_seen
  from public.riders r
  join public.rider_locations rl on rl.rider_id = r.id
  where r.is_active
    and r.availability = 'online'
    and (r.unavailable_until is null or r.unavailable_until <= now())
    and rl.last_seen > now() - make_interval(secs => v_stale)
    and st_dwithin(rl.location, v_pickup, v_radius)
    -- a rider sees each booking at most once
    and not exists (
      select 1 from public.booking_dispatches d
      where d.booking_id = p_booking_id and d.rider_id = r.id
    )
    -- not already driving someone
    and not exists (
      select 1 from public.bookings b2
      where b2.rider_id = r.id
        and b2.status = any (public.live_booking_statuses())
    )
    -- not deciding on someone else's request right now
    and not exists (
      select 1 from public.booking_dispatches d2
      where d2.rider_id = r.id
        and d2.status = 'pending'
        and d2.expires_at > now()
        and d2.booking_id <> p_booking_id
    )
    -- vehicle class must match when the rider has registered a vehicle at all
    and (
      not exists (select 1 from public.vehicles v where v.rider_id = r.id)
      or exists (
        select 1 from public.vehicles v
        where v.rider_id = r.id and v.vehicle_type = v_type
      )
    )
  order by distance_m asc
  limit greatest(p_limit, 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- Terminal state: nobody took it (spec section 7 step 4)
-- ---------------------------------------------------------------------------
create or replace function public.fail_booking_no_rider(
  p_booking_id uuid,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
begin
  update public.bookings
     set status = 'no_rider_available'
   where id = p_booking_id
     and status = 'searching'
  returning customer_id into v_customer;

  if v_customer is null then
    return;  -- already resolved by someone else
  end if;

  update public.booking_dispatches
     set status = 'cancelled', responded_at = now()
   where booking_id = p_booking_id and status = 'pending';

  perform public.push_notification(
    v_customer, 'no_rider_available',
    'No riders available',
    'We could not find a rider nearby. You can try again.',
    p_booking_id,
    jsonb_build_object('reason', p_reason)
  );

  perform public.log_booking_event(
    p_booking_id, 'no_rider_available', 'searching', 'no_rider_available',
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- THE sequential dispatcher (spec section 7 step 3)
--
-- Offers the booking to exactly one rider - the nearest untried eligible one -
-- and stamps a server-side deadline. Never offers to two riders at once.
-- Returns the new dispatch id, or NULL when the booking could not be advanced.
-- ---------------------------------------------------------------------------
create or replace function public.offer_next_rider(p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking     public.bookings;
  v_window      integer := public.app_setting_int('dispatch_window_seconds', 10);
  v_max         integer := public.app_setting_int('max_dispatch_attempts', 10);
  v_rider       uuid;
  v_distance    double precision;
  v_last_seen   timestamptz;
  v_dispatch_id uuid;
  v_offered     integer;
  v_expires     timestamptz;
begin
  -- Serialise every dispatch decision for this booking.
  select * into v_booking from public.bookings where id = p_booking_id for update;

  if not found or v_booking.status <> 'searching' then
    return null;
  end if;

  -- Whole-booking search timeout.
  if v_booking.search_expires_at is not null and v_booking.search_expires_at <= now() then
    perform public.fail_booking_no_rider(p_booking_id, 'search_timeout');
    return null;
  end if;

  -- Hard invariant: at most one live offer per booking.
  if exists (
    select 1 from public.booking_dispatches
    where booking_id = p_booking_id and status = 'pending' and expires_at > now()
  ) then
    return null;
  end if;

  select count(*) into v_offered
  from public.booking_dispatches where booking_id = p_booking_id;

  if v_offered >= v_max then
    perform public.fail_booking_no_rider(p_booking_id, 'max_attempts_reached');
    return null;
  end if;

  select n.rider_id, n.distance_m, n.last_seen
    into v_rider, v_distance, v_last_seen
  from public.find_nearby_riders(p_booking_id, 1) n;

  if v_rider is null then
    perform public.fail_booking_no_rider(p_booking_id, 'no_eligible_riders');
    return null;
  end if;

  v_expires := now() + make_interval(secs => v_window);

  insert into public.booking_dispatches
    (booking_id, rider_id, sequence, distance_m, expires_at)
  values
    (p_booking_id, v_rider, v_offered + 1, v_distance, v_expires)
  returning id into v_dispatch_id;

  update public.bookings set dispatch_round = v_offered + 1 where id = p_booking_id;

  perform public.push_notification(
    v_rider, 'ride_request',
    'New ride request',
    format('Pickup %s km away', round((v_distance / 1000.0)::numeric, 1)),
    p_booking_id,
    jsonb_build_object(
      'dispatch_id', v_dispatch_id,
      'expires_at',  v_expires,
      'sequence',    v_offered + 1,
      'distance_m',  v_distance
    )
  );

  perform public.log_booking_event(
    p_booking_id, 'dispatch_offered', null, null,
    jsonb_build_object(
      'rider_id',   v_rider,
      'sequence',   v_offered + 1,
      'distance_m', v_distance,
      'expires_at', v_expires
    )
  );

  return v_dispatch_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Booking creation (spec section 5 steps 8 and 9)
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
  p_vehicle_type       text    default 'car',
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
    coalesce(p_vehicle_type, 'car'), 'searching',
    now() + make_interval(secs => v_timeout),
    p_idempotency_key
  )
  returning id into v_booking_id;

  perform public.log_booking_event(
    v_booking_id, 'booking_created', null, 'searching',
    jsonb_build_object(
      'estimated_distance', p_estimated_distance,
      'estimated_duration', p_estimated_duration,
      'vehicle_type',       p_vehicle_type
    )
  );

  perform public.push_notification(
    v_uid, 'booking_created',
    'Looking for a rider',
    'We are contacting riders near your pickup point.',
    v_booking_id
  );

  -- Kick off the sequential dispatch immediately; pg_cron advances it from here.
  perform public.offer_next_rider(v_booking_id);

  return v_booking_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic acceptance (spec section 7 step 5 and section 19.8)
-- ---------------------------------------------------------------------------
create or replace function public.accept_booking(p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_dispatch public.booking_dispatches;
  v_claimed  uuid;
  v_customer uuid;
  v_name     text;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select * into v_dispatch
  from public.booking_dispatches
  where booking_id = p_booking_id and rider_id = v_uid
  for update;

  if not found then raise exception 'no_offer_for_rider'; end if;

  if v_dispatch.status <> 'pending' then
    raise exception 'offer_not_pending' using detail = v_dispatch.status::text;
  end if;

  if v_dispatch.expires_at <= now() then
    update public.booking_dispatches
       set status = 'timeout', responded_at = now()
     where id = v_dispatch.id;
    raise exception 'offer_expired';
  end if;

  if not exists (select 1 from public.riders where id = v_uid and is_active) then
    raise exception 'rider_deactivated';
  end if;

  if exists (
    select 1 from public.bookings
    where rider_id = v_uid and status = any (public.live_booking_statuses())
  ) then
    raise exception 'rider_busy';
  end if;

  -- ===== The atomic claim =================================================
  -- Concurrent accepts serialise on this row lock. Postgres re-evaluates the
  -- WHERE clause after acquiring the lock, so the loser matches zero rows.
  update public.bookings
     set rider_id    = v_uid,
         status      = 'assigned',
         accepted_at = now()
   where id = p_booking_id
     and status = 'searching'
     and rider_id is null
  returning id, customer_id into v_claimed, v_customer;

  if v_claimed is null then
    raise exception 'booking_taken';
  end if;
  -- ========================================================================

  update public.booking_dispatches
     set status = 'accepted', responded_at = now()
   where id = v_dispatch.id;

  -- Everyone else's card disappears (spec section 7 step 5).
  update public.booking_dispatches
     set status = 'cancelled', responded_at = now()
   where booking_id = p_booking_id
     and id <> v_dispatch.id
     and status = 'pending';

  update public.riders set availability = 'busy' where id = v_uid;

  select full_name into v_name from public.profiles where id = v_uid;

  perform public.push_notification(
    v_customer, 'rider_assigned',
    'Rider on the way',
    coalesce(nullif(v_name, ''), 'Your rider') || ' accepted your ride.',
    p_booking_id,
    jsonb_build_object('rider_id', v_uid)
  );

  perform public.log_booking_event(
    p_booking_id, 'booking_accepted', 'searching', 'assigned',
    jsonb_build_object('rider_id', v_uid, 'sequence', v_dispatch.sequence)
  );

  return p_booking_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rejection: mark and immediately advance (spec section 7 "If a rider rejects")
-- ---------------------------------------------------------------------------
create or replace function public.reject_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  update public.booking_dispatches
     set status = 'rejected', responded_at = now()
   where booking_id = p_booking_id
     and rider_id = v_uid
     and status = 'pending'
  returning id into v_id;

  if v_id is null then raise exception 'no_pending_offer'; end if;

  perform public.log_booking_event(
    p_booking_id, 'dispatch_rejected', null, null,
    jsonb_build_object('rider_id', v_uid)
  );

  -- No waiting for the next tick.
  perform public.offer_next_rider(p_booking_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Status progression state machine (spec section 12)
-- ---------------------------------------------------------------------------
create or replace function public.advance_booking_status(
  p_booking_id uuid,
  p_to         booking_status
)
returns booking_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_booking public.bookings;
  v_ok      boolean := false;
  v_admin   boolean := public.is_privileged();
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  -- Only the assigned rider drives the ride forward (admins may intervene).
  if v_booking.rider_id is distinct from v_uid and not v_admin then
    raise exception 'not_assigned_rider';
  end if;

  -- The only legal edges (spec section 12). Written out rather than as a row
  -- comparison so the enum types are unambiguous.
  v_ok := (v_booking.status = 'assigned'       and p_to = 'rider_arriving')
       or (v_booking.status = 'rider_arriving' and p_to = 'arrived')
       or (v_booking.status = 'arrived'        and p_to = 'in_progress')
       or (v_booking.status = 'in_progress'    and p_to = 'completed');

  if not v_ok then
    raise exception 'illegal_transition' using detail = v_booking.status::text || ' -> ' || p_to::text;
  end if;

  update public.bookings
     set status       = p_to,
         arrived_at   = case when p_to = 'arrived'     then now() else arrived_at   end,
         started_at   = case when p_to = 'in_progress' then now() else started_at   end,
         completed_at = case when p_to = 'completed'   then now() else completed_at end
   where id = p_booking_id;

  -- Finishing frees the rider and credits the ride.
  if p_to = 'completed' then
    update public.riders
       set availability = case when availability = 'busy' then 'online' else availability end,
           total_rides  = total_rides + 1
     where id = v_booking.rider_id;
  end if;

  perform public.push_notification(
    v_booking.customer_id,
    case p_to
      when 'rider_arriving' then 'rider_arriving'::notification_type
      when 'arrived'        then 'rider_arrived'::notification_type
      when 'in_progress'    then 'trip_started'::notification_type
      else                       'trip_completed'::notification_type
    end,
    case p_to
      when 'rider_arriving' then 'Rider is on the way'
      when 'arrived'        then 'Your rider has arrived'
      when 'in_progress'    then 'Trip started'
      else                       'Trip completed'
    end,
    case p_to
      when 'rider_arriving' then 'Track your rider on the map.'
      when 'arrived'        then 'Your rider is waiting at the pickup point.'
      when 'in_progress'    then 'Enjoy your ride.'
      else                       'Thanks for riding with us.'
    end,
    p_booking_id
  );

  perform public.log_booking_event(
    p_booking_id, 'status_changed', v_booking.status, p_to, '{}'::jsonb
  );

  return p_to;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancellation (spec section 12 "Cancellation rules validated on the backend")
-- ---------------------------------------------------------------------------
create or replace function public.cancel_booking(
  p_booking_id uuid,
  p_reason     text default null
)
returns booking_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_booking    public.bookings;
  v_admin      boolean := public.is_privileged();
  v_is_customer boolean;
  v_is_rider    boolean;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  v_is_customer := v_booking.customer_id = v_uid;
  v_is_rider    := v_booking.rider_id is not distinct from v_uid and v_uid is not null
                   and v_booking.rider_id is not null;

  if not (v_is_customer or v_is_rider or v_admin) then
    raise exception 'not_authorized';
  end if;

  if v_booking.status in ('completed', 'cancelled', 'no_rider_available') then
    raise exception 'booking_not_cancellable' using detail = v_booking.status::text;
  end if;

  -- A trip in motion can only be stopped by an admin.
  if v_booking.status = 'in_progress' and not v_admin then
    raise exception 'trip_in_progress';
  end if;

  -- Customer cancellation after a rider committed is policy-gated.
  if v_is_customer and not v_admin
     and v_booking.status <> 'searching'
     and not public.app_setting_bool('allow_customer_cancel_after_accept', true) then
    raise exception 'cancel_window_closed';
  end if;

  update public.bookings
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = v_uid,
         cancellation_reason = p_reason
   where id = p_booking_id;

  update public.booking_dispatches
     set status = 'cancelled', responded_at = now()
   where booking_id = p_booking_id and status = 'pending';

  -- Release the rider.
  if v_booking.rider_id is not null then
    update public.riders
       set availability = case when availability = 'busy' then 'online' else availability end
     where id = v_booking.rider_id;
  end if;

  -- Tell the other party.
  if v_is_customer then
    perform public.push_notification(
      v_booking.rider_id, 'booking_cancelled',
      'Ride cancelled', 'The customer cancelled this ride.', p_booking_id
    );
  else
    perform public.push_notification(
      v_booking.customer_id, 'booking_cancelled',
      'Ride cancelled',
      case when v_admin and not v_is_rider
           then 'Your ride was cancelled by support.'
           else 'Your rider cancelled. You can book again.' end,
      p_booking_id
    );
  end if;

  perform public.log_booking_event(
    p_booking_id, 'booking_cancelled', v_booking.status, 'cancelled',
    jsonb_build_object('reason', p_reason, 'by_role',
      case when v_admin then 'admin' when v_is_customer then 'customer' else 'rider' end)
  );

  return 'cancelled';
end;
$$;

-- ---------------------------------------------------------------------------
-- Retry after no_rider_available (spec section 7 step 4)
--
-- Clears the offer ledger so previously-contacted riders become eligible
-- again. booking_events retains the full history of the earlier round.
-- ---------------------------------------------------------------------------
create or replace function public.retry_booking_dispatch(p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_booking public.bookings;
  v_timeout integer := public.app_setting_int('search_timeout_seconds', 180);
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  if v_booking.customer_id <> v_uid and not public.is_privileged() then
    raise exception 'not_authorized';
  end if;

  if v_booking.status <> 'no_rider_available' then
    raise exception 'booking_not_retryable' using detail = v_booking.status::text;
  end if;

  delete from public.booking_dispatches where booking_id = p_booking_id;

  update public.bookings
     set status            = 'searching',
         dispatch_round    = 0,
         search_expires_at = now() + make_interval(secs => v_timeout)
   where id = p_booking_id;

  perform public.log_booking_event(
    p_booking_id, 'dispatch_retried', 'no_rider_available', 'searching'
  );

  perform public.offer_next_rider(p_booking_id);
  return p_booking_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- THE SERVER-SIDE CLOCK (spec section 7 "reliable server-side scheduling")
--
-- Invoked by pg_cron every 5 seconds (see 0006) and by the dispatch-tick Edge
-- Function as a fallback. Idempotent: running it twice is harmless, and a late
-- run can never double-assign because every decision re-checks state under a
-- row lock.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row       record;
  v_expired   integer := 0;
  v_offered   integer := 0;
  v_parked    integer := 0;
  v_new_offer uuid;
begin
  -- 1. Reap offers whose server-side deadline has passed.
  for v_row in
    select d.id, d.booking_id, d.rider_id
    from public.booking_dispatches d
    join public.bookings b on b.id = d.booking_id
    where d.status = 'pending'
      and d.expires_at <= now()
      and b.status = 'searching'
    for update of d skip locked
  loop
    update public.booking_dispatches
       set status = 'timeout', responded_at = now()
     where id = v_row.id;

    perform public.push_notification(
      v_row.rider_id, 'request_expired',
      'Request expired', 'That ride request went to another rider.',
      v_row.booking_id
    );

    perform public.log_booking_event(
      v_row.booking_id, 'dispatch_timeout', null, null,
      jsonb_build_object('rider_id', v_row.rider_id)
    );

    v_expired := v_expired + 1;
  end loop;

  -- 2. Cancel stragglers attached to bookings that have moved on.
  update public.booking_dispatches d
     set status = 'cancelled', responded_at = now()
   where d.status = 'pending'
     and exists (
       select 1 from public.bookings b
       where b.id = d.booking_id and b.status <> 'searching'
     );

  -- 3. Advance every searching booking that currently has no live offer.
  for v_row in
    select b.id
    from public.bookings b
    where b.status = 'searching'
      and not exists (
        select 1 from public.booking_dispatches d
        where d.booking_id = b.id and d.status = 'pending' and d.expires_at > now()
      )
    order by b.created_at
    limit 200
  loop
    v_new_offer := public.offer_next_rider(v_row.id);
    if v_new_offer is not null then
      v_offered := v_offered + 1;
    end if;
  end loop;

  -- 4. Park riders whose GPS has gone quiet for three staleness windows.
  --    (spec section 16: browser GPS dies when the phone locks.)
  update public.riders r
     set availability = 'offline'
   where r.availability = 'online'
     and not exists (
       select 1 from public.rider_locations rl
       where rl.rider_id = r.id
         and rl.last_seen > now()
              - make_interval(secs => public.app_setting_int('gps_stale_seconds', 45) * 3)
     );
  get diagnostics v_parked = row_count;

  return jsonb_build_object(
    'expired',       v_expired,
    'offered',       v_offered,
    'riders_parked', v_parked,
    'at',            now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin overrides
-- ---------------------------------------------------------------------------
create or replace function public.admin_assign_rider(
  p_booking_id uuid,
  p_rider_id   uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  if not public.is_privileged() then raise exception 'not_authorized'; end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;

  if v_booking.status not in ('searching', 'no_rider_available') then
    raise exception 'booking_not_assignable' using detail = v_booking.status::text;
  end if;

  if not exists (select 1 from public.riders where id = p_rider_id and is_active) then
    raise exception 'rider_unavailable';
  end if;

  if exists (
    select 1 from public.bookings
    where rider_id = p_rider_id and status = any (public.live_booking_statuses())
  ) then
    raise exception 'rider_busy';
  end if;

  update public.bookings
     set rider_id = p_rider_id, status = 'assigned', accepted_at = now()
   where id = p_booking_id;

  update public.booking_dispatches
     set status = 'cancelled', responded_at = now()
   where booking_id = p_booking_id and status = 'pending';

  insert into public.booking_dispatches
    (booking_id, rider_id, sequence, status, expires_at, responded_at)
  values
    (p_booking_id, p_rider_id,
     coalesce((select max(sequence) from public.booking_dispatches where booking_id = p_booking_id), 0) + 1,
     'accepted', now(), now())
  on conflict (booking_id, rider_id) do update
     set status = 'accepted', responded_at = now();

  update public.riders set availability = 'busy' where id = p_rider_id;

  perform public.push_notification(
    p_rider_id, 'ride_request', 'Ride assigned to you',
    'Support assigned you a ride. Open the app for details.', p_booking_id
  );
  perform public.push_notification(
    v_booking.customer_id, 'rider_assigned', 'Rider on the way',
    'Support assigned a rider to your booking.', p_booking_id
  );

  perform public.log_booking_event(
    p_booking_id, 'admin_assigned', v_booking.status, 'assigned',
    jsonb_build_object('rider_id', p_rider_id)
  );

  return p_booking_id;
end;
$$;

create or replace function public.admin_set_rider_active(
  p_rider_id uuid,
  p_active   boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_privileged() then raise exception 'not_authorized'; end if;

  if not p_active and exists (
    select 1 from public.bookings
    where rider_id = p_rider_id and status = any (public.live_booking_statuses())
  ) then
    raise exception 'rider_has_active_booking';
  end if;

  update public.riders
     set is_active    = p_active,
         availability = case when p_active then availability else 'offline' end
   where id = p_rider_id;

  return p_active;
end;
$$;

create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_privileged() then raise exception 'not_authorized'; end if;

  insert into public.admin_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update
     set value = excluded.value, updated_at = now(), updated_by = auth.uid();

  return p_value;
end;
$$;

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stale integer := public.app_setting_int('gps_stale_seconds', 45);
begin
  if not public.is_privileged() then raise exception 'not_authorized'; end if;

  return jsonb_build_object(
    'customers',  (select count(*) from public.profiles where role = 'customer'),
    'riders',     (select count(*) from public.riders),
    'riders_online', (select count(*) from public.riders where availability = 'online' and is_active),
    'riders_offline',(select count(*) from public.riders where availability = 'offline'),
    'riders_busy',   (select count(*) from public.riders where availability = 'busy'),
    'riders_stale',  (
      select count(*) from public.riders r
      where r.availability = 'online'
        and not exists (
          select 1 from public.rider_locations rl
          where rl.rider_id = r.id and rl.last_seen > now() - make_interval(secs => v_stale)
        )
    ),
    'bookings_total',     (select count(*) from public.bookings),
    'bookings_active',    (select count(*) from public.bookings
                            where status in ('searching','assigned','rider_arriving','arrived','in_progress')),
    'bookings_completed', (select count(*) from public.bookings where status = 'completed'),
    'bookings_cancelled', (select count(*) from public.bookings where status = 'cancelled'),
    'bookings_failed',    (select count(*) from public.bookings where status = 'no_rider_available'),
    'bookings_today',     (select count(*) from public.bookings where created_at >= date_trunc('day', now())),
    'revenue_today',      (select coalesce(sum(estimated_fare), 0) from public.bookings
                            where status = 'completed' and completed_at >= date_trunc('day', now()))
  );
end;
$$;

-- Rider's own earnings/summary panel (spec section 6).
create or replace function public.rider_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  return jsonb_build_object(
    'rides_today', (select count(*) from public.bookings
                     where rider_id = v_uid and status = 'completed'
                       and completed_at >= date_trunc('day', now())),
    'rides_total', (select count(*) from public.bookings
                     where rider_id = v_uid and status = 'completed'),
    'earnings_today', (select coalesce(sum(estimated_fare), 0) from public.bookings
                        where rider_id = v_uid and status = 'completed'
                          and completed_at >= date_trunc('day', now())),
    'earnings_total', (select coalesce(sum(estimated_fare), 0) from public.bookings
                        where rider_id = v_uid and status = 'completed'),
    'rating', (select rating from public.riders where id = v_uid),
    'acceptance_rate', (
      select case when count(*) = 0 then null
                  else round(100.0 * count(*) filter (where status = 'accepted') / count(*)) end
      from public.booking_dispatches where rider_id = v_uid
    )
  );
end;
$$;

-- Mark notifications read without exposing an UPDATE policy surface.
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  update public.notifications
     set read_at = now()
   where user_id = v_uid
     and read_at is null
     and (p_ids is null or id = any (p_ids));

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.register_device_token(
  p_token    text,
  p_platform text default 'web'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_token is null or length(p_token) < 16 then raise exception 'invalid_token'; end if;

  insert into public.device_tokens (user_id, token, platform)
  values (v_uid, p_token, p_platform)
  on conflict (token) do update
     set user_id = v_uid, last_used_at = now()
  returning id into v_id;

  return v_id;
end;
$$;
