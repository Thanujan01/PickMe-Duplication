import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'node:path';

/**
 * HTTPS in development.
 *
 * Browsers only expose geolocation, notifications and service workers in a
 * "secure context". `http://localhost` counts as one; `http://192.168.x.x`
 * does NOT. So testing the rider app from a phone over the LAN silently fails
 * to get a GPS fix unless the dev server speaks HTTPS.
 *
 *   npm run dev        -> http://localhost:5173      (fine on this machine)
 *   npm run dev:https  -> https://192.168.x.x:5173   (needed for phones)
 *
 * The certificate is self-signed, so the phone will show a warning once -
 * tap Advanced -> Proceed.
 */
const useHttps = process.env.HTTPS === 'true';

/**
 * Base path.
 *
 * GitHub Pages serves a project site from a sub-path
 * (`/PickMe-Duplication/`), not the domain root, so every asset URL and the
 * router basename have to be prefixed. Vercel, Netlify and local dev all serve
 * from `/`.
 *
 *   npm run build         -> base "/"
 *   npm run build:pages   -> base "/PickMe-Duplication/"
 */
const base = process.env.DEPLOY_TARGET === 'gh-pages' ? '/PickMe-Duplication/' : '/';

export default defineConfig({
  base,
  plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          vendor: ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
});
