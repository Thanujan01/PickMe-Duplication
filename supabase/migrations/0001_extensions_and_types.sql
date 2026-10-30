-- =============================================================================
-- 0001  Extensions and enumerated types
-- =============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists postgis;

-- pg_cron creates its own `cron` schema and is what drives the dispatch clock.
-- Harmless if already enabled from the dashboard (Database -> Extensions).
create extension if not exists pg_cron;

-- pg_net gives us fire-and-forget HTTP from SQL, used only for the optional
-- push-notification relay.
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type user_role as enum ('customer', 'rider', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type rider_availability as enum ('offline', 'online', 'busy');
exception when duplicate_object then null; end $$;

-- Booking lifecycle. See ARCHITECTURE.md section 3.2 for the legal transitions.
do $$ begin
  create type booking_status as enum (
    'searching',
    'assigned',
    'rider_arriving',
    'arrived',
    'in_progress',
    'completed',
    'cancelled',
    'no_rider_available'
  );
exception when duplicate_object then null; end $$;

-- One row per (booking, rider) offer.
do $$ begin
  create type dispatch_status as enum (
    'pending',    -- offered, awaiting a response, expires_at in the future
    'accepted',   -- this rider won the booking
    'rejected',   -- rider explicitly declined
    'timeout',    -- expires_at passed with no response
    'cancelled'   -- another rider accepted, or the booking ended
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type notification_type as enum (
    'booking_created',
    'ride_request',
    'request_expired',
    'rider_assigned',
    'rider_arriving',
    'rider_arrived',
    'trip_started',
    'trip_completed',
    'booking_cancelled',
    'no_rider_available'
  );
exception when duplicate_object then null; end $$;
