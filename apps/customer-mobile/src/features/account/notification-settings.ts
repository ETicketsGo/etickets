import { apiClient } from '@/services/api-client';

/**
 * What a person receives, and where — the mobile half of the same settings.
 *
 * ── WHY THE SHAPES MIRROR THE WEB CLIENT EXACTLY ───────────────────────────────────
 * Because they are the same endpoints answering the same questions, and the rules a customer
 * is subject to are properties of the platform rather than of the screen they happen to be
 * looking at. `required` and `deferred` come from the server precisely so that neither client
 * has to decide for itself which switches to grey out — a decision two clients make
 * separately is a decision they will eventually make differently.
 */

export interface NotificationChannelPreference {
  channel: 'email' | 'sms' | 'whatsapp' | 'push' | 'in_app';
  enabled: boolean;
  /** Guaranteed by policy: shown as required, never as a switch that does nothing. */
  required: boolean;
  /** The emergency SMS. Opens only if a cancelled show reached you nowhere else. */
  deferred: boolean;
}

export interface NotificationPreferences {
  /** Whether each channel has anywhere to send to, so the UI can explain a dead toggle. */
  destinations: { hasPhone: boolean; phoneVerified: boolean; emailUsable: boolean };
  types: {
    type: string;
    urgency: 'ROUTINE' | 'IMPORTANT' | 'URGENT';
    channels: NotificationChannelPreference[];
  }[];
}

export interface ConsentState {
  channels: {
    channel: string;
    granted: boolean;
    source: string | null;
    decidedAt: string | null;
  }[];
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  const { data } = await apiClient.get<NotificationPreferences>('/me/notification-preferences');
  return data;
}

export async function setNotificationPreference(body: {
  type: string;
  channel: string;
  enabled: boolean;
}): Promise<NotificationPreferences> {
  const { data } = await apiClient.put<NotificationPreferences>(
    '/me/notification-preferences',
    body,
  );
  return data;
}

export async function fetchConsent(): Promise<ConsentState> {
  const { data } = await apiClient.get<ConsentState>('/me/marketing-consent');
  return data;
}

/**
 * Record a consent decision.
 *
 * `whatsapp:transactional` is permission to use WhatsApp for somebody's own booking;
 * `whatsapp` is permission to sell to them there. Passing one where the other is meant is how
 * a person who declined offers stops receiving their tickets, so the caller names the scope
 * explicitly rather than the client inferring it from a screen.
 */
export async function setConsent(body: {
  channel: string;
  granted: boolean;
}): Promise<ConsentState['channels']> {
  const { data } = await apiClient.put<ConsentState['channels']>('/me/marketing-consent', body);
  return data;
}
