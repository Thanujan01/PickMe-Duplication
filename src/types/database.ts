/**
 * Hand-maintained mirror of the SQL schema in supabase/migrations.
 *
 * Regenerate-able alternative:
 *   npx supabase gen types typescript --project-id <ref> > src/types/database.ts
 * It is hand-written here so the repo type-checks before anyone has a project.
 */

export type UserRole = 'customer' | 'rider' | 'admin';
export type RiderAvailability = 'offline' | 'online' | 'busy';

export type BookingStatus =
  | 'searching'
  | 'assigned'
  | 'rider_arriving'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_rider_available';

export type DispatchStatus = 'pending' | 'accepted' | 'rejected' | 'timeout' | 'cancelled';

export type NotificationType =
  | 'booking_created'
  | 'ride_request'
  | 'request_expired'
  | 'rider_assigned'
  | 'rider_arriving'
  | 'rider_arrived'
  | 'trip_started'
  | 'trip_completed'
  | 'booking_cancelled'
  | 'no_rider_available';

export type VehicleType = 'car' | 'bike' | 'tuk' | 'van';

export interface Profile {
  id: string;
  role: UserRole;
  full_name: string;
  phone: string | null;
  avatar_url: string | null;
  is_blocked: boolean;
  created_at: string;
  updated_at: string;
}

export interface Rider {
  id: string;
  is_active: boolean;
  availability: RiderAvailability;
  license_number: string | null;
  rating: number;
  total_rides: number;
  unavailable_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Vehicle {
  id: string;
  rider_id: string;
  vehicle_type: VehicleType;
  make: string;
  model: string;
  color: string;
  plate_number: string;
  year: number | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export interface RiderLocation {
  rider_id: string;
  latitude: number;
  longitude: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  last_seen: string;
  updated_at: string;
}

export interface Booking {
  id: string;
  customer_id: string;
  rider_id: string | null;
  pickup_latitude: number;
  pickup_longitude: number;
  pickup_address: string;
  destination_latitude: number;
  destination_longitude: number;
  destination_address: string;
  estimated_distance: number | null;
  estimated_duration: number | null;
  estimated_fare: number | null;
  vehicle_type: VehicleType;
  status: BookingStatus;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  dispatch_round: number;
  search_expires_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  accepted_at: string | null;
  arrived_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
}

export interface BookingDispatch {
  id: string;
  booking_id: string;
  rider_id: string;
  sequence: number;
  distance_m: number | null;
  status: DispatchStatus;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
}

export interface BookingEvent {
  id: string;
  booking_id: string;
  actor_id: string | null;
  event_type: string;
  from_status: BookingStatus | null;
  to_status: BookingStatus | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AppNotification {
  id: string;
  user_id: string;
  booking_id: string | null;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface AdminSetting {
  key: string;
  value: unknown;
  label: string;
  updated_at: string;
  updated_by: string | null;
}

// --- Shapes returned by RPCs -------------------------------------------------

export interface AdminStats {
  customers: number;
  riders: number;
  riders_online: number;
  riders_offline: number;
  riders_busy: number;
  riders_stale: number;
  bookings_total: number;
  bookings_active: number;
  bookings_completed: number;
  bookings_cancelled: number;
  bookings_failed: number;
  bookings_today: number;
  revenue_today: number;
}

export interface RiderStats {
  rides_today: number;
  rides_total: number;
  earnings_today: number;
  earnings_total: number;
  rating: number | null;
  acceptance_rate: number | null;
}

export interface NearbyRider {
  rider_id: string;
  distance_m: number;
  last_seen: string;
}

// --- Composite shapes assembled by nested selects ---------------------------

export interface RiderWithProfile extends Rider {
  profile: Pick<Profile, 'id' | 'full_name' | 'phone' | 'avatar_url'> | null;
  vehicles: Vehicle[];
  location?: RiderLocation | null;
}

export interface BookingWithParties extends Booking {
  customer: Pick<Profile, 'id' | 'full_name' | 'phone' | 'avatar_url'> | null;
  rider: RiderWithProfile | null;
}
