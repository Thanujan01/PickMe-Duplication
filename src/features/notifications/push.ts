import { env, fcmConfigured } from '@/lib/env';
import { supabase } from '@/lib/supabase';

/**
 * Notification delivery, in two tiers.
 *
 * Tier 1 (always available, zero setup): the page is open, Supabase Realtime
 * delivers the notification row, and we raise it through the service worker's
 * Notification API. Works offline-of-tab on desktop and on Android while the
 * PWA is backgrounded but not killed.
 *
 * Tier 2 (optional): Firebase Cloud Messaging, which also reaches a fully
 * closed app. Enabled only when the VITE_FIREBASE_* variables are present.
 *
 * Spec section 13: "The application must remain usable if push notifications
 * are unavailable." Nothing here throws into the UI - every path degrades.
 */

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

export function pushPermission(): PushPermission {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission as PushPermission;
}

export async function requestPushPermission(): Promise<PushPermission> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission as PushPermission;

  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') void registerForFcm();
    return result as PushPermission;
  } catch {
    return 'denied';
  }
}

/** Raise a notification locally. No server, no third party. */
export async function showLocalNotification(options: {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
  requireInteraction?: boolean;
}): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(options.title, {
      body: options.body,
      tag: options.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      data: { url: options.url ?? '/' },
      requireInteraction: options.requireInteraction ?? false,
      // A ride request should be impossible to miss.
      silent: false,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Short vibration + beep for a new ride request, for the case where the rider
 * has the app open and notification permission denied.
 */
export function alertRider(): void {
  try {
    navigator.vibrate?.([220, 90, 220, 90, 320]);
  } catch {
    /* unsupported */
  }

  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
    osc.onended = () => void ctx.close();
  } catch {
    /* autoplay policy may block this until the first interaction */
  }
}

// --- Optional FCM tier -------------------------------------------------------

let fcmRegistered = false;

/**
 * Registers this browser with FCM and stores the token so the push-notify Edge
 * Function can target it. Imported lazily so the firebase SDK is never
 * downloaded when FCM is not configured.
 */
export async function registerForFcm(): Promise<string | null> {
  if (!fcmConfigured || fcmRegistered || !pushSupported()) return null;
  if (Notification.permission !== 'granted') return null;

  try {
    const [{ initializeApp, getApps }, { getMessaging, getToken }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);

    const app = getApps().length
      ? getApps()[0]
      : initializeApp({
          apiKey: env.fcm.apiKey,
          authDomain: env.fcm.authDomain,
          projectId: env.fcm.projectId,
          messagingSenderId: env.fcm.messagingSenderId,
          appId: env.fcm.appId,
        });

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/firebase-cloud-messaging-push-scope',
    });

    const token = await getToken(getMessaging(app), {
      vapidKey: env.fcm.vapidKey,
      serviceWorkerRegistration: registration,
    });

    if (!token) return null;

    await supabase.rpc('register_device_token', { p_token: token, p_platform: 'web' });
    fcmRegistered = true;
    return token;
  } catch (e) {
    // FCM is an enhancement. Log for the developer, stay silent for the user.
    if (env.isDev) console.warn('[push] FCM registration failed:', e);
    return null;
  }
}
