import { NotificationType } from '@eticketsgo/shared-types';

/** The set of delivery channels the platform knows about. */
export type ChannelKey = 'email' | 'sms' | 'whatsapp' | 'push' | 'in_app';

/**
 * A fully rendered notification ready for delivery on a single channel. The
 * template service produces `subject`/`body`; the raw `payload` is passed
 * through so channels/providers can build richer messages if needed.
 */
export interface RenderedNotification {
  type: NotificationType;
  channel: ChannelKey;
  locale: string;
  toEmail?: string | null;
  userId?: string | null;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
}

/**
 * A delivery channel. MVP implementations are log-only stubs; each documents
 * where a real provider (SendGrid/Twilio/FCM/…) would bind.
 */
export interface NotificationChannel {
  readonly key: ChannelKey;
  deliver(msg: RenderedNotification): Promise<void>;
}
