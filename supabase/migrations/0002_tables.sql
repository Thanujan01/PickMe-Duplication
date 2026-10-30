-- =============================================================================
-- 0002  Core tables
-- =============================================================================

-- ---------------------------------------------------------------------------
-- profiles : one row per auth.users row, created by trigger (see 0003)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        user_role   not null default 'customer',
  full_name   text        not null default '',
  phone       text,
  avatar_url  text,
  is_blocked  boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_phone_format check (phone is null or phone ~ '^[+0-9 ()-]{6,24}$')
);

create index if not exists profiles_role_idx on public.profiles (role);

-- ---------------------------------------------------------------------------
-- riders : rider-specific state. PK is also the profile id.
-- ---------------------------------------------------------------------------
create table if not exists public.riders (
  id              uuid primary key references public.profiles (id) on delete cascade,
  is_active       boolean            not null default true,
  availability    rider_availability not null default 'offline',
  license_number  text,
  rating          numeric(3, 2)      not null default 5.00 check (rating >= 0 and rating <= 5),
  total_rides     integer            not null default 0 check (total_rides >= 0),
  -- set while a rider is temporarily barred from dispatch (e.g. after repeated
  -- timeouts); checked by find_nearby_riders
  unavailable_until timestamptz,
  created_at      timestamptz        not null default now(),
  updated_at      timestamptz        not null default now()
);

create index if not exists riders_dispatchable_idx
  on public.riders (availability, is_active)
  where availability = 'online' and is_active;

-- ---------------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------------
create table if not exists public.vehicles (
  id            uuid primary key default gen_random_uuid(),
  rider_id      uuid not null references public.riders (id) on delete cascade,
  vehicle_type  text not null default 'car'
                check (vehicle_type in ('car', 'bike', 'tuk', 'van')),
  make          text not null default '',
  model         text not null default '',
  color         text not null default '',
  plate_number  text not null,
  year          integer check (year is null or (year between 1950 and 2100)),
  is_primary    boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint vehicles_plate_unique unique (plate_number)
);

create index if not exists vehicles_rider_idx on public.vehicles (rider_id);
-- at most one primary vehicle per rider
create unique index if not exists vehicles_one_primary_idx
  on public.vehicles (rider_id) where is_primary;

-- ---------------------------------------------------------------------------
-- rider_locations : current position only (one row per rider, overwritten).
-- `location` is maintained by a trigger from latitude/longitude so clients
-- never have to send PostGIS geometry.
-- ---------------------------------------------------------------------------
create table if not exists public.rider_locations (
  rider_id   uuid primary key references public.riders (id) on delete cascade,
  latitude   double precision not null check (latitude between -90 and 90),
  longitude  double precision not null check (longitude between -180 and 180),
  location   geography(Point, 4326),
  heading    double precision check (heading is null or (heading >= 0 and heading < 360)),
  speed      double precision check (speed is null or speed >= 0),
  accuracy   double precision check (accuracy is null or accuracy >= 0),
  last_seen  timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rider_locations_geo_idx
  on public.rider_locations using gist (location);
create index if not exists rider_locations_last_seen_idx
  on public.rider_locations (last_seen desc);

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id                     uuid primary key default gen_random_uuid(),
  customer_id            uuid not null references public.profiles (id) on delete cascade,
  rider_id               uuid references public.riders (id) on delete set null,

  pickup_latitude        double precision not null check (pickup_latitude between -90 and 90),
  pickup_longitude       double precision not null check (pickup_longitude between -180 and 180),
  pickup_address         text not null default '',
  pickup_location        geography(Point, 4326),

  destination_latitude   double precision not null check (destination_latitude between -90 and 90),
  destination_longitude  double precision not null check (destination_longitude between -180 and 180),
  destination_address    text not null default '',
  destination_location   geography(Point, 4326),

  -- metres and seconds, as estimated by the routing provider at booking time
  estimated_distance     integer check (estimated_distance is null or estimated_distance >= 0),
  estimated_duration     integer check (estimated_duration is null or estimated_duration >= 0),
  estimated_fare         numeric(10, 2) check (estimated_fare is null or estimated_fare >= 0),
  vehicle_type           text not null default 'car'
                         check (vehicle_type in ('car', 'bike', 'tuk', 'van')),

  status                 booking_status not null default 'searching',
  cancelled_by           uuid references public.profiles (id) on delete set null,
  cancellation_reason    text,

  -- dispatch bookkeeping
  dispatch_round         integer not null default 0 check (dispatch_round >= 0),
  search_expires_at      timestamptz,

  -- idempotency: a client may retry create_booking with the same key safely
  idempotency_key        text,

  created_at             timestamptz not null default now(),
  accepted_at            timestamptz,
  arrived_at             timestamptz,
  started_at             timestamptz,
  completed_at           timestamptz,
  cancelled_at           timestamptz,
  updated_at             timestamptz not null default now(),

  -- A rider must be present for every live state. 'completed' is deliberately
  -- excluded so that ON DELETE SET NULL on a removed rider cannot invalidate
  -- historical rows.
  constraint bookings_rider_required check (
    status not in ('assigned', 'rider_arriving', 'arrived', 'in_progress')
    or rider_id is not null
  )
);

create unique index if not exists bookings_idempotency_idx
  on public.bookings (customer_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists bookings_customer_idx on public.bookings (customer_id, created_at desc);
create index if not exists bookings_rider_idx    on public.bookings (rider_id, created_at desc);
create index if not exists bookings_status_idx   on public.bookings (status, created_at desc);
create index if not exists bookings_searching_idx
  on public.bookings (search_expires_at) where status = 'searching';
create index if not exists bookings_pickup_geo_idx
  on public.bookings using gist (pickup_location);

-- A customer may hold only one live booking at a time.
create unique index if not exists bookings_one_live_per_customer_idx
  on public.bookings (customer_id)
  where status in ('searching', 'assigned', 'rider_arriving', 'arrived', 'in_progress');

-- A rider may hold only one live booking at a time. This is the second line of
-- defence behind accept_booking()'s conditional update.
create unique index if not exists bookings_one_live_per_rider_idx
  on public.bookings (rider_id)
  where rider_id is not null
    and status in ('assigned', 'rider_arriving', 'arrived', 'in_progress');

-- ---------------------------------------------------------------------------
-- booking_dispatches : the sequential offer ledger
-- ---------------------------------------------------------------------------
create table if not exists public.booking_dispatches (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references public.bookings (id) on delete cascade,
  rider_id      uuid not null references public.riders (id) on delete cascade,
  sequence      integer not null check (sequence > 0),
  distance_m    double precision,
  status        dispatch_status not null default 'pending',
  offered_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  responded_at  timestamptz,
  constraint booking_dispatches_once unique (booking_id, rider_id),
  constraint booking_dispatches_seq_once unique (booking_id, sequence)
);

create index if not exists booking_dispatches_pending_idx
  on public.booking_dispatches (expires_at)
  where status = 'pending';
create index if not exists booking_dispatches_rider_idx
  on public.booking_dispatches (rider_id, status, offered_at desc);
create index if not exists booking_dispatches_booking_idx
  on public.booking_dispatches (booking_id, sequence);

-- ---------------------------------------------------------------------------
-- booking_events : append-only audit trail
-- ---------------------------------------------------------------------------
create table if not exists public.booking_events (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  event_type  text not null,
  from_status booking_status,
  to_status   booking_status,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists booking_events_booking_idx
  on public.booking_events (booking_id, created_at);

-- ---------------------------------------------------------------------------
-- notifications : in-app inbox, streamed over Realtime
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  booking_id  uuid references public.bookings (id) on delete cascade,
  type        notification_type not null,
  title       text not null,
  body        text not null default '',
  data        jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- device_tokens : FCM web-push registrations
-- ---------------------------------------------------------------------------
create table if not exists public.device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  token        text not null unique,
  platform     text not null default 'web' check (platform in ('web', 'android', 'ios')),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on public.device_tokens (user_id);

-- ---------------------------------------------------------------------------
-- admin_settings : runtime tunables, editable from the admin dashboard
-- ---------------------------------------------------------------------------
create table if not exists public.admin_settings (
  key        text primary key,
  value      jsonb not null,
  label      text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);

insert into public.admin_settings (key, value, label) values
  ('dispatch_window_seconds', '10'::jsonb,   'Seconds each rider has to accept an offer'),
  ('dispatch_radius_m',       '15000'::jsonb,'Maximum pickup distance to consider a rider (metres)'),
  ('gps_stale_seconds',       '45'::jsonb,   'A rider whose GPS is older than this is skipped'),
  ('search_timeout_seconds',  '180'::jsonb,  'Give up searching for a rider after this long'),
  ('max_dispatch_attempts',   '10'::jsonb,   'Maximum riders contacted per booking'),
  ('fare_base',               '150'::jsonb,  'Base fare'),
  ('fare_per_km',             '70'::jsonb,   'Fare per kilometre'),
  ('fare_per_min',            '4'::jsonb,    'Fare per minute'),
  ('allow_customer_cancel_after_accept', 'true'::jsonb, 'Customers may cancel after a rider accepts')
on conflict (key) do nothing;
