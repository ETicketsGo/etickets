// Browser Web Push helpers (v1.4). Reuse the existing service worker registration;
// the API exposes the VAPID public key and stores subscriptions. When no VAPID key
// is configured server-side, push is reported unsupported (graceful placeholder).
import { api } from '@/lib/api';

export type PushSupport = 'unsupported' | 'denied' | 'default' | 'granted';

/** Whether the browser can do Web Push at all. */
export function pushCapable(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Current permission/support state, factoring in server VAPID configuration. */
export async function pushState(): Promise<PushSupport> {
  if (!pushCapable()) return 'unsupported';
  const { publicKey } = await api.pushVapidKey().catch(() => ({ publicKey: null }));
  if (!publicKey) return 'unsupported'; // server hasn't configured VAPID → placeholder
  return Notification.permission as PushSupport;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Ask for permission, subscribe via the SW, and register with the API. */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushCapable()) return { ok: false, reason: 'unsupported' };
  const { publicKey } = await api.pushVapidKey().catch(() => ({ publicKey: null }));
  if (!publicKey) return { ok: false, reason: 'not-configured' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, reason: 'invalid-subscription' };
  }
  await api.pushSubscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    userAgent: navigator.userAgent,
  });
  return { ok: true };
}

/** Unsubscribe the browser and remove it server-side. */
export async function disablePush(): Promise<void> {
  if (!pushCapable()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await api.pushUnsubscribe(endpoint).catch(() => undefined);
}

/** Register a one-off background sync for wallet refresh (no-op if unsupported). */
export async function requestWalletSync(): Promise<void> {
  if (!pushCapable()) return;
  try {
    const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };
    await reg.sync?.register('etg-wallet-sync');
  } catch {
    /* Background Sync unsupported — the page's network-first query still refreshes. */
  }
}
