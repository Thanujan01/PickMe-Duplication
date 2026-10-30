import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { configWarnings, env } from './lib/env';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// --- Service worker (PWA shell + notifications) -----------------------------
// Registered after first paint so it never delays the map.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((e) => {
      // The app works fine without it; only install and offline shell are lost.
      console.warn('[pwa] service worker registration failed:', e);
    });
  });
}

// Clicking a notification asks the worker to focus or open the right screen.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === 'navigate' && data.url) {
      window.location.assign(data.url);
    }
  });
}

if (env.isDev && configWarnings.length) {
  for (const warning of configWarnings) console.warn('[config]', warning);
}

// Dev-only console handle. TESTING.md uses it to probe RLS from the browser as
// a real signed-in user. Not exposed in production builds.
if (env.isDev) {
  void import('./lib/supabase').then(({ supabase }) => {
    (window as unknown as Record<string, unknown>).__ride = { supabase };
    console.info('[dev] window.__ride.supabase is available (see TESTING.md)');
  });
}
