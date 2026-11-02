import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { ConfigScreen } from '@/components/shared/ConfigScreen';
import { configErrors } from '@/lib/env';
import { queryClient } from '@/lib/query';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { AppRoutes } from './routes';

export default function App() {
  // A deploy missing its Supabase credentials explains itself rather than
  // throwing a blank page (spec section 21).
  if (configErrors.length) return <ConfigScreen errors={configErrors} />;

  return (
    <QueryClientProvider client={queryClient}>
      {/* BASE_URL is '/' locally and '/PickMe-Duplication/' on GitHub Pages. */}
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthProvider>
          <AppRoutes />
          <Toaster
            position="top-center"
            richColors
            closeButton
            toastOptions={{ className: 'rounded-xl' }}
          />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
