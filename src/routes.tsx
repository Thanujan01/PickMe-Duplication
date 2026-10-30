import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { RedirectIfAuthed, RequireRole } from '@/features/auth/guards';

// Route-level code splitting: a customer never downloads the admin dashboard.
const Login = lazy(() => import('@/pages/auth/Login'));
const Register = lazy(() => import('@/pages/auth/Register'));
const ResetPassword = lazy(() => import('@/pages/auth/ResetPassword'));

const CustomerHome = lazy(() => import('@/pages/customer/Home'));
const CustomerHistory = lazy(() => import('@/pages/customer/History'));
const TripDetail = lazy(() => import('@/pages/customer/TripDetail'));

const RiderDashboard = lazy(() => import('@/pages/rider/Dashboard'));
const RiderHistory = lazy(() => import('@/pages/rider/History'));

const AdminOverview = lazy(() => import('@/pages/admin/Overview'));
const AdminRiders = lazy(() => import('@/pages/admin/Riders'));
const AdminBookings = lazy(() => import('@/pages/admin/Bookings'));
const AdminFleet = lazy(() => import('@/pages/admin/Fleet'));
const AdminSettings = lazy(() => import('@/pages/admin/Settings'));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Public */}
        <Route element={<RedirectIfAuthed />}>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
        </Route>
        {/* Reachable while signed in: the recovery link creates a session. */}
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Customer */}
        <Route element={<RequireRole allow={['customer']} />}>
          <Route path="/" element={<CustomerHome />} />
          <Route path="/history" element={<CustomerHistory />} />
        </Route>

        {/* Shared: a trip receipt is readable by both parties (RLS decides). */}
        <Route element={<RequireRole allow={['customer', 'rider', 'admin']} />}>
          <Route path="/trip/:id" element={<TripDetail />} />
        </Route>

        {/* Rider */}
        <Route element={<RequireRole allow={['rider']} />}>
          <Route path="/rider" element={<RiderDashboard />} />
          <Route path="/rider/history" element={<RiderHistory />} />
        </Route>

        {/* Admin */}
        <Route element={<RequireRole allow={['admin']} />}>
          <Route path="/admin" element={<AdminOverview />} />
          <Route path="/admin/riders" element={<AdminRiders />} />
          <Route path="/admin/bookings" element={<AdminBookings />} />
          <Route path="/admin/fleet" element={<AdminFleet />} />
          <Route path="/admin/settings" element={<AdminSettings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
