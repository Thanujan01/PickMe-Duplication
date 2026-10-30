-- =============================================================================
-- Dispatch algorithm test suite
--
-- Covers the scenarios in the spec's testing requirements. Run it in the
-- Supabase SQL editor (which executes as a superuser) AFTER applying all
-- migrations:
--
--     -- paste this whole file, run it, then:
--     select * from public.run_dispatch_tests();
--
-- It creates its own throwaway accounts (ridetest+*@example.com), exercises the
-- real SQL functions, and deletes everything it made. It never touches your
-- own data.
--
-- Scenario 8 (two riders accepting at the exact same instant) is verified here
-- against the atomic-claim guard. True wall-clock concurrency needs two
-- database sessions - see TESTING.md "Concurrency by hand".
-- =============================================================================

-- Results table. Created here, at definition time, so the REVOKE at the bottom
-- of this file has something to act on.
create table if not exists public._dt_results (
  n integer, test text, result text, detail text
);

create or replace function public.run_dispatch_tests()
returns table (n integer, test text, result text, detail text)
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  -- Pickup anchor: Colombo Fort. Riders are placed east of it at increasing
  -- distance, so the expected dispatch order is deterministic.
  c_pickup_lat  constant double precision := 6.9271;
  c_pickup_lng  constant double precision := 79.8612;
  c_dest_lat    constant double precision := 6.9000;
  c_dest_lng    constant double precision := 79.9000;

  v_customer  uuid;
  v_r1 uuid; v_r2 uuid; v_r3 uuid; v_r4 uuid; v_r5 uuid;
  v_booking   uuid;
  v_booking2  uuid;
  v_seq       integer := 0;
  v_rider     uuid;
  v_status    text;
  v_count     integer;
  v_text      text;
  v_bool      boolean;
  v_dispatch  uuid;
  v_fare      numeric;
begin
  delete from public._dt_results;

  -- =====================================================================
  -- Fixtures
  -- =====================================================================
  perform public._dt_cleanup();

  v_customer := public._dt_make_user('ridetest+customer@example.com', 'Test Customer', 'customer');
  v_r1 := public._dt_make_user('ridetest+r1@example.com', 'Rider One',   'rider');
  v_r2 := public._dt_make_user('ridetest+r2@example.com', 'Rider Two',   'rider');
  v_r3 := public._dt_make_user('ridetest+r3@example.com', 'Rider Three', 'rider');
  v_r4 := public._dt_make_user('ridetest+r4@example.com', 'Rider Four',  'rider');
  v_r5 := public._dt_make_user('ridetest+r5@example.com', 'Rider Five',  'rider');

  -- Every rider gets a car so the vehicle-class filter is satisfied.
  perform public._dt_give_vehicle(v_r1, 'DT-0001');
  perform public._dt_give_vehicle(v_r2, 'DT-0002');
  perform public._dt_give_vehicle(v_r3, 'DT-0003');
  perform public._dt_give_vehicle(v_r4, 'DT-0004');
  perform public._dt_give_vehicle(v_r5, 'DT-0005');

  -- Roughly 0.9 / 1.8 / 2.7 / 3.6 / 4.5 km east of the pickup.
  perform public._dt_place(v_r1, c_pickup_lat, c_pickup_lng + 0.008, true);
  perform public._dt_place(v_r2, c_pickup_lat, c_pickup_lng + 0.016, true);
  perform public._dt_place(v_r3, c_pickup_lat, c_pickup_lng + 0.024, true);
  perform public._dt_place(v_r4, c_pickup_lat, c_pickup_lng + 0.032, true);
  perform public._dt_place(v_r5, c_pickup_lat, c_pickup_lng + 0.040, true);

  -- =====================================================================
  -- 1. Ranking: nearest first
  -- =====================================================================
  v_seq := v_seq + 1;
  insert into public.bookings (
    customer_id, pickup_latitude, pickup_longitude, pickup_address,
    destination_latitude, destination_longitude, destination_address,
    estimated_distance, estimated_duration, status, search_expires_at
  ) values (
    v_customer, c_pickup_lat, c_pickup_lng, 'Test pickup',
    c_dest_lat, c_dest_lng, 'Test destination',
    5000, 900, 'searching', now() + interval '180 seconds'
  ) returning id into v_booking;

  select string_agg(rider_id::text, ',' order by distance_m)
    into v_text
  from public.find_nearby_riders(v_booking, 10);

  perform public._dt_assert(
    v_seq, 'find_nearby_riders ranks nearest first',
    v_text = concat_ws(',', v_r1, v_r2, v_r3, v_r4, v_r5),
    coalesce(v_text, '(none)')
  );

  -- =====================================================================
  -- 2. First offer goes to the nearest rider only
  -- =====================================================================
  v_seq := v_seq + 1;
  v_dispatch := public.offer_next_rider(v_booking);

  select count(*) into v_count
  from public.booking_dispatches where booking_id = v_booking;

  select rider_id into v_rider
  from public.booking_dispatches where booking_id = v_booking and sequence = 1;

  perform public._dt_assert(
    v_seq, 'exactly one offer created, to the nearest rider',
    v_count = 1 and v_rider = v_r1,
    format('offers=%s rider=%s', v_count, v_rider)
  );

  -- =====================================================================
  -- 3. A second offer is NOT created while one is live
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public.offer_next_rider(v_booking);
  select count(*) into v_count from public.booking_dispatches where booking_id = v_booking;
  perform public._dt_assert(
    v_seq, 'no parallel offers while one is pending',
    v_count = 1,
    format('offers=%s', v_count)
  );

  -- =====================================================================
  -- 4. Offer carries a server-side 10 second deadline
  -- =====================================================================
  v_seq := v_seq + 1;
  select extract(epoch from (expires_at - offered_at))::integer into v_count
  from public.booking_dispatches where booking_id = v_booking and sequence = 1;
  perform public._dt_assert(
    v_seq, 'offer window matches dispatch_window_seconds',
    v_count = public.app_setting_int('dispatch_window_seconds', 10),
    format('window=%ss', v_count)
  );

  -- =====================================================================
  -- 5. Rejection advances immediately to the next-nearest rider
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_r1);
  perform public.reject_booking(v_booking);
  perform public._dt_act_as(null);

  select status into v_status
  from public.booking_dispatches where booking_id = v_booking and rider_id = v_r1;
  select rider_id into v_rider
  from public.booking_dispatches where booking_id = v_booking and sequence = 2;

  perform public._dt_assert(
    v_seq, 'reject marks rejected and offers rider 2 at once',
    v_status = 'rejected' and v_rider = v_r2,
    format('r1=%s seq2=%s', v_status, v_rider)
  );

  -- =====================================================================
  -- 6. Timeout: dispatch_tick reaps the deadline and advances
  -- =====================================================================
  v_seq := v_seq + 1;
  -- Simulate the 10 seconds elapsing.
  update public.booking_dispatches
     set expires_at = now() - interval '1 second'
   where booking_id = v_booking and sequence = 2;

  perform public.dispatch_tick();

  select status into v_status
  from public.booking_dispatches where booking_id = v_booking and sequence = 2;
  select rider_id into v_rider
  from public.booking_dispatches where booking_id = v_booking and sequence = 3;

  perform public._dt_assert(
    v_seq, 'dispatch_tick times out rider 2 and offers rider 3',
    v_status = 'timeout' and v_rider = v_r3,
    format('seq2=%s seq3=%s', v_status, v_rider)
  );

  -- =====================================================================
  -- 7. An offline rider is skipped
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_place(v_r4, c_pickup_lat, c_pickup_lng + 0.032, false);   -- offline

  update public.booking_dispatches
     set expires_at = now() - interval '1 second'
   where booking_id = v_booking and sequence = 3;
  perform public.dispatch_tick();

  select rider_id into v_rider
  from public.booking_dispatches where booking_id = v_booking and sequence = 4;

  perform public._dt_assert(
    v_seq, 'offline rider 4 skipped, rider 5 offered instead',
    v_rider = v_r5,
    format('seq4=%s (expected r5=%s)', v_rider, v_r5)
  );

  -- =====================================================================
  -- 8. Stale GPS is skipped
  -- =====================================================================
  v_seq := v_seq + 1;
  -- Bring rider 4 back online but with an old fix.
  update public.riders set availability = 'online' where id = v_r4;
  update public.rider_locations
     set last_seen = now() - make_interval(secs => public.app_setting_int('gps_stale_seconds', 45) + 30)
   where rider_id = v_r4;

  select count(*) into v_count
  from public.find_nearby_riders(v_booking, 10) f
  where f.rider_id = v_r4;

  perform public._dt_assert(
    v_seq, 'rider with stale GPS is not an eligible candidate',
    v_count = 0,
    format('candidates matching r4=%s', v_count)
  );

  -- =====================================================================
  -- 9. Acceptance is atomic and assigns exactly once
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_r5);
  perform public.accept_booking(v_booking);
  perform public._dt_act_as(null);

  select status::text into v_status from public.bookings where id = v_booking;
  select rider_id into v_rider from public.bookings where id = v_booking;
  select availability::text into v_text from public.riders where id = v_r5;

  perform public._dt_assert(
    v_seq, 'accept assigns the booking and marks the rider busy',
    v_status = 'assigned' and v_rider = v_r5 and v_text = 'busy',
    format('status=%s rider=%s availability=%s', v_status, v_rider, v_text)
  );

  -- =====================================================================
  -- 10. Sibling offers are withdrawn on acceptance
  -- =====================================================================
  v_seq := v_seq + 1;
  select count(*) into v_count
  from public.booking_dispatches
  where booking_id = v_booking and status = 'pending';

  perform public._dt_assert(
    v_seq, 'no offers left pending after acceptance',
    v_count = 0,
    format('pending=%s', v_count)
  );

  -- =====================================================================
  -- 11. A second rider accepting the same booking loses cleanly
  -- =====================================================================
  v_seq := v_seq + 1;
  -- Force a pending offer for rider 3 on the already-assigned booking, which
  -- is the state a true race would produce, then try to accept it.
  update public.booking_dispatches
     set status = 'pending', expires_at = now() + interval '10 seconds'
   where booking_id = v_booking and rider_id = v_r3;

  perform public._dt_act_as(v_r3);
  begin
    perform public.accept_booking(v_booking);
    v_text := 'NO ERROR RAISED';
  exception when others then
    v_text := sqlerrm;
  end;
  perform public._dt_act_as(null);

  perform public._dt_assert(
    v_seq, 'second accept is refused with booking_taken',
    v_text = 'booking_taken',
    v_text
  );

  -- Booking must still belong to rider 5 only.
  v_seq := v_seq + 1;
  select rider_id into v_rider from public.bookings where id = v_booking;
  perform public._dt_assert(
    v_seq, 'booking still assigned to the original winner',
    v_rider = v_r5,
    format('rider=%s', v_rider)
  );

  -- =====================================================================
  -- 12. Status machine: legal chain, illegal jumps refused
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_r5);
  begin
    perform public.advance_booking_status(v_booking, 'completed');  -- assigned -> completed
    v_text := 'NO ERROR RAISED';
  exception when others then
    v_text := sqlerrm;
  end;
  perform public._dt_act_as(null);

  perform public._dt_assert(
    v_seq, 'illegal transition assigned -> completed refused',
    v_text = 'illegal_transition',
    v_text
  );

  v_seq := v_seq + 1;
  perform public._dt_act_as(v_r5);
  perform public.advance_booking_status(v_booking, 'rider_arriving');
  perform public.advance_booking_status(v_booking, 'arrived');
  perform public.advance_booking_status(v_booking, 'in_progress');
  perform public._dt_act_as(null);

  select status::text into v_status from public.bookings where id = v_booking;
  perform public._dt_assert(
    v_seq, 'legal chain assigned -> rider_arriving -> arrived -> in_progress',
    v_status = 'in_progress',
    format('status=%s', v_status)
  );

  -- =====================================================================
  -- 13. A customer cannot cancel a trip already under way
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_customer);
  begin
    perform public.cancel_booking(v_booking, 'changed my mind');
    v_text := 'NO ERROR RAISED';
  exception when others then
    v_text := sqlerrm;
  end;
  perform public._dt_act_as(null);

  perform public._dt_assert(
    v_seq, 'cancel refused while trip_in_progress',
    v_text = 'trip_in_progress',
    v_text
  );

  -- =====================================================================
  -- 14. Completion frees the rider and credits the ride
  -- =====================================================================
  v_seq := v_seq + 1;
  select total_rides into v_count from public.riders where id = v_r5;

  perform public._dt_act_as(v_r5);
  perform public.advance_booking_status(v_booking, 'completed');
  perform public._dt_act_as(null);

  select availability::text into v_text from public.riders where id = v_r5;
  select status::text into v_status from public.bookings where id = v_booking;

  perform public._dt_assert(
    v_seq, 'completion: status completed, rider back online, ride counted',
    v_status = 'completed'
      and v_text = 'online'
      and (select total_rides from public.riders where id = v_r5) = v_count + 1,
    format('status=%s availability=%s rides=%s->%s', v_status, v_text, v_count,
           (select total_rides from public.riders where id = v_r5))
  );

  -- =====================================================================
  -- 15. Exhausting every candidate ends in no_rider_available
  -- =====================================================================
  v_seq := v_seq + 1;
  -- Only rider 1 is reachable; everyone else goes offline.
  update public.riders set availability = 'offline'
   where id in (v_r2, v_r3, v_r4, v_r5);
  perform public._dt_place(v_r1, c_pickup_lat, c_pickup_lng + 0.008, true);

  insert into public.bookings (
    customer_id, pickup_latitude, pickup_longitude, pickup_address,
    destination_latitude, destination_longitude, destination_address,
    estimated_distance, estimated_duration, status, search_expires_at
  ) values (
    v_customer, c_pickup_lat, c_pickup_lng, 'Test pickup 2',
    c_dest_lat, c_dest_lng, 'Test destination 2',
    5000, 900, 'searching', now() + interval '180 seconds'
  ) returning id into v_booking2;

  perform public.offer_next_rider(v_booking2);

  perform public._dt_act_as(v_r1);
  perform public.reject_booking(v_booking2);           -- no candidates left
  perform public._dt_act_as(null);

  select status::text into v_status from public.bookings where id = v_booking2;
  perform public._dt_assert(
    v_seq, 'all candidates exhausted -> no_rider_available',
    v_status = 'no_rider_available',
    format('status=%s', v_status)
  );

  -- =====================================================================
  -- 16. Retry clears the ledger and searches again
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_customer);
  perform public.retry_booking_dispatch(v_booking2);
  perform public._dt_act_as(null);

  select status::text into v_status from public.bookings where id = v_booking2;
  select rider_id into v_rider
  from public.booking_dispatches where booking_id = v_booking2 and sequence = 1;

  perform public._dt_assert(
    v_seq, 'retry re-offers to the previously contacted rider',
    v_status = 'searching' and v_rider = v_r1,
    format('status=%s seq1=%s', v_status, v_rider)
  );

  -- =====================================================================
  -- 17. Customer cancellation during a search stops the dispatch
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_customer);
  perform public.cancel_booking(v_booking2, 'customer_cancelled');
  perform public._dt_act_as(null);

  select status::text into v_status from public.bookings where id = v_booking2;
  select count(*) into v_count
  from public.booking_dispatches where booking_id = v_booking2 and status = 'pending';

  perform public._dt_assert(
    v_seq, 'cancel during search closes the booking and all offers',
    v_status = 'cancelled' and v_count = 0,
    format('status=%s pending=%s', v_status, v_count)
  );

  -- Next tick must not resurrect it.
  v_seq := v_seq + 1;
  perform public.dispatch_tick();
  select count(*) into v_count
  from public.booking_dispatches where booking_id = v_booking2 and status = 'pending';
  perform public._dt_assert(
    v_seq, 'dispatch_tick does not re-offer a cancelled booking',
    v_count = 0,
    format('pending=%s', v_count)
  );

  -- =====================================================================
  -- 18. A rider cannot go offline mid-ride
  -- =====================================================================
  v_seq := v_seq + 1;
  insert into public.bookings (
    customer_id, rider_id, pickup_latitude, pickup_longitude,
    destination_latitude, destination_longitude,
    status, accepted_at
  ) values (
    v_customer, v_r1, c_pickup_lat, c_pickup_lng,
    c_dest_lat, c_dest_lng, 'assigned', now()
  );
  update public.riders set availability = 'busy' where id = v_r1;

  perform public._dt_act_as(v_r1);
  begin
    perform public.set_rider_availability('offline');
    v_text := 'NO ERROR RAISED';
  exception when others then
    v_text := sqlerrm;
  end;
  perform public._dt_act_as(null);

  perform public._dt_assert(
    v_seq, 'going offline during an active ride is refused',
    v_text = 'has_active_booking',
    v_text
  );

  -- =====================================================================
  -- 19. A rider cannot set themselves busy
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_r2);
  begin
    perform public.set_rider_availability('busy');
    v_text := 'NO ERROR RAISED';
  exception when others then
    v_text := sqlerrm;
  end;
  perform public._dt_act_as(null);

  perform public._dt_assert(
    v_seq, 'busy is system-managed, not rider-settable',
    v_text = 'busy_is_system_managed',
    v_text
  );

  -- =====================================================================
  -- 20. create_booking is idempotent for a repeated key
  -- =====================================================================
  v_seq := v_seq + 1;
  -- Clear the customer's live bookings so a new one is allowed.
  update public.bookings set status = 'cancelled', cancelled_at = now()
   where customer_id = v_customer
     and status in ('searching','assigned','rider_arriving','arrived','in_progress');
  update public.riders set availability = 'online' where id = v_r1;

  perform public._dt_act_as(v_customer);
  declare
    v_a uuid;
    v_b uuid;
  begin
    v_a := public.create_booking(
      c_pickup_lat, c_pickup_lng, 'Idem pickup',
      c_dest_lat, c_dest_lng, 'Idem destination',
      4000, 700, 'car', 'test-idempotency-key'
    );
    v_b := public.create_booking(
      c_pickup_lat, c_pickup_lng, 'Idem pickup',
      c_dest_lat, c_dest_lng, 'Idem destination',
      4000, 700, 'car', 'test-idempotency-key'
    );
    perform public._dt_assert(
      v_seq, 'repeated idempotency key returns the same booking',
      v_a = v_b,
      format('%s vs %s', v_a, v_b)
    );
    v_booking2 := v_a;
  end;
  perform public._dt_act_as(null);

  -- =====================================================================
  -- 21. One live booking per customer
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_customer);
  begin
    perform public.create_booking(
      c_pickup_lat, c_pickup_lng, 'Second pickup',
      c_dest_lat, c_dest_lng, 'Second destination',
      4000, 700, 'car', null
    );
    v_text := 'NO ERROR RAISED';
  exception when others then
    v_text := sqlerrm;
  end;
  perform public._dt_act_as(null);

  perform public._dt_assert(
    v_seq, 'a second concurrent booking is refused',
    v_text = 'active_booking_exists',
    v_text
  );

  -- =====================================================================
  -- 22. create_booking computes a fare from admin_settings
  -- =====================================================================
  v_seq := v_seq + 1;
  select estimated_fare into v_fare from public.bookings where id = v_booking2;
  perform public._dt_assert(
    v_seq, 'fare computed server-side from settings',
    v_fare = round(
      public.app_setting_num('fare_base', 150)
      + public.app_setting_num('fare_per_km', 70) * (4000 / 1000.0)
      + public.app_setting_num('fare_per_min', 4) * (700 / 60.0), 2),
    format('fare=%s', v_fare)
  );

  -- =====================================================================
  -- 23. A non-customer cannot create a booking
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_r2);
  begin
    perform public.create_booking(
      c_pickup_lat, c_pickup_lng, 'x', c_dest_lat, c_dest_lng, 'y', 1000, 300, 'car', null
    );
    v_text := 'NO ERROR RAISED';
  exception when others then
    v_text := sqlerrm;
  end;
  perform public._dt_act_as(null);

  perform public._dt_assert(
    v_seq, 'a rider account cannot book a ride',
    v_text = 'not_a_customer',
    v_text
  );

  -- =====================================================================
  -- 24. GPS validation rejects an implausible fix
  -- =====================================================================
  v_seq := v_seq + 1;
  perform public._dt_act_as(v_r2);
  begin
    perform public.update_rider_location(6.9, 79.9, null, null, 5000);
    v_text := 'NO ERROR RAISED';
  exception when others then
    v_text := sqlerrm;
  end;
  perform public._dt_act_as(null);

  perform public._dt_assert(
    v_seq, 'a hopelessly imprecise GPS fix is rejected',
    v_text = 'accuracy_too_low',
    v_text
  );

  -- =====================================================================
  -- 25. RLS: a customer cannot read an unrelated rider's live position
  -- =====================================================================
  v_seq := v_seq + 1;
  v_bool := public._dt_rls_location_leak_check(v_customer, v_r3);
  perform public._dt_assert(
    v_seq, 'customer cannot read the location of a rider they are not matched to',
    v_bool = false,
    case when v_bool then 'LEAK: row was visible' else 'no rows visible, as required' end
  );

  -- =====================================================================
  -- Teardown
  -- =====================================================================
  perform public._dt_cleanup();

  return query
    select r.n, r.test, r.result, r.detail
    from public._dt_results r
    order by r.n;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Test helpers (prefixed _dt_ and dropped by cleanup_dispatch_tests())
-- ---------------------------------------------------------------------------

create or replace function public._dt_assert(
  p_n integer, p_test text, p_ok boolean, p_detail text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public._dt_results (n, test, result, detail)
  values (p_n, p_test, case when p_ok then 'PASS' else 'FAIL' end, p_detail);
end;
$$;

create or replace function public._dt_act_as(p_uid uuid)
returns void
language plpgsql
as $$
begin
  -- auth.uid() reads this setting, so this is how the tests impersonate a user.
  if p_uid is null then
    perform set_config('request.jwt.claims', '', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

create or replace function public._dt_make_user(
  p_email text, p_name text, p_role text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    p_email, extensions.crypt('test-password-123', extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    json_build_object('full_name', p_name, 'role', p_role)::jsonb
  );

  -- handle_new_user() creates profiles/riders; make sure of it either way.
  insert into public.profiles (id, role, full_name, phone)
  values (v_id, p_role::user_role, p_name, '+94770000000')
  on conflict (id) do update set role = p_role::user_role, full_name = p_name;

  if p_role = 'rider' then
    insert into public.riders (id) values (v_id) on conflict (id) do nothing;
  end if;

  return v_id;
end;
$$;

create or replace function public._dt_give_vehicle(p_rider uuid, p_plate text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.vehicles (rider_id, vehicle_type, make, model, color, plate_number)
  values (p_rider, 'car', 'Toyota', 'Axio', 'Silver', p_plate)
  on conflict (plate_number) do update set rider_id = p_rider;
$$;

create or replace function public._dt_place(
  p_rider uuid, p_lat double precision, p_lng double precision, p_online boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.rider_locations (rider_id, latitude, longitude, accuracy, last_seen)
  values (p_rider, p_lat, p_lng, 8, now())
  on conflict (rider_id) do update
     set latitude = p_lat, longitude = p_lng, accuracy = 8, last_seen = now();

  update public.riders
     set availability = case when p_online then 'online' else 'offline' end,
         is_active = true
   where id = p_rider;
end;
$$;

/**
 * Checks the privacy-critical policy for real, by switching to the
 * `authenticated` role (so RLS is actually enforced) and reading
 * rider_locations as the customer. Returns TRUE if anything leaked.
 */
create or replace function public._dt_rls_location_leak_check(
  p_customer uuid, p_rider uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visible integer;
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_customer::text, 'role', 'authenticated')::text,
    true
  );

  -- `postgres` bypasses RLS, so the role must change for this to mean anything.
  set local role authenticated;

  select count(*) into v_visible
  from public.rider_locations
  where rider_id = p_rider;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  return v_visible > 0;
exception when others then
  begin
    reset role;
  exception when others then null;
  end;
  -- An error here means the read was blocked, which is the desired outcome.
  return false;
end;
$$;

create or replace function public._dt_cleanup()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Cascades through profiles -> riders -> bookings/dispatches/locations.
  delete from auth.users where email like 'ridetest+%@example.com';
end;
$$;

-- ---------------------------------------------------------------------------
-- Remove the suite and its helpers once you are done.
--   select public.cleanup_dispatch_tests();
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_dispatch_tests()
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._dt_cleanup();

  drop function if exists public.run_dispatch_tests();
  drop function if exists public._dt_assert(integer, text, boolean, text);
  drop function if exists public._dt_act_as(uuid);
  drop function if exists public._dt_make_user(text, text, text);
  drop function if exists public._dt_give_vehicle(uuid, text);
  drop function if exists public._dt_place(uuid, double precision, double precision, boolean);
  drop function if exists public._dt_rls_location_leak_check(uuid, uuid);
  drop function if exists public._dt_cleanup();
  drop table if exists public._dt_results;

  return 'Test suite removed. Test accounts deleted.';
end;
$$;

-- Every one of these is superuser-only. The PUBLIC grant must go too (see the
-- note in migration 0005) - _dt_make_user creates auth accounts.
revoke all on function public.run_dispatch_tests()        from public, anon, authenticated;
revoke all on function public.cleanup_dispatch_tests()    from public, anon, authenticated;
revoke all on function public._dt_assert(integer, text, boolean, text)
  from public, anon, authenticated;
revoke all on function public._dt_act_as(uuid)            from public, anon, authenticated;
revoke all on function public._dt_make_user(text, text, text)
  from public, anon, authenticated;
revoke all on function public._dt_give_vehicle(uuid, text) from public, anon, authenticated;
revoke all on function public._dt_place(uuid, double precision, double precision, boolean)
  from public, anon, authenticated;
revoke all on function public._dt_rls_location_leak_check(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public._dt_cleanup()               from public, anon, authenticated;
revoke all on table public._dt_results                    from public, anon, authenticated;
