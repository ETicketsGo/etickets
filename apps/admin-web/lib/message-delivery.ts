import type { AdminNotificationRow, BadgeTone } from '@eticketsgo/web-kit';

/**
 * The messages sent about one booking, in the words support reads to a buyer.
 *
 * -- WHY THE PILL FOLLOWS `delivery` AND NOT `status` -----------------------------
 * `status` said SENT for messages that never left the platform: a WhatsApp to somebody with
 * no phone number, and every email and push the log transport printed. Those rows are still
 * in the database as they were written. The API reads every fact on the row and returns a
 * verdict, and this page shows that - so "Sent" is never printed for something nobody got.
 *
 * Display only. Nothing here decides anything.
 */

export type MessageVerdict = AdminNotificationRow['delivery']['verdict'];

const VERDICT: Record<MessageVerdict, { word: string; tone: BadgeTone }> = {
  DELIVERED: { word: 'Delivered', tone: 'success' },
  IN_APP: { word: 'In the app', tone: 'success' },
  ACCEPTED: { word: 'Sent, not confirmed', tone: 'info' },
  IN_PROGRESS: { word: 'Waiting', tone: 'info' },
  NOT_DELIVERED: { word: 'Not delivered', tone: 'error' },
  NOT_SENT: { word: 'Not sent', tone: 'warning' },
  LOG_ONLY: { word: 'Not sent (log only)', tone: 'warning' },
  CANCELLED: { word: 'Cancelled', tone: 'neutral' },
};

export function verdictPill(verdict: MessageVerdict): { word: string; tone: BadgeTone } {
  return VERDICT[verdict] ?? { word: 'Unknown', tone: 'neutral' };
}

const CHANNEL: Record<string, string> = {
  email: 'Email',
  sms: 'Text message',
  whatsapp: 'WhatsApp',
  push: 'Push notification',
  in_app: 'In-app message',
};

export function channelName(channel: string): string {
  return CHANNEL[channel] ?? channel;
}

const MESSAGE: Record<string, string> = {
  BOOKING_CONFIRMED: 'Booking confirmed',
  BOOKING_CANCELLED: 'Booking cancelled',
  PAYMENT_FAILED: 'Payment failed',
  REFUND_REQUESTED: 'Refund requested',
  REFUND_COMPLETED: 'Refund completed',
  SHOW_CANCELLED: 'Show cancelled',
  SHOW_CHANGED: 'Show changed',
  EVENT_REMINDER: 'Reminder',
  GUEST_BOOKING_ACCESS: 'Guest ticket link',
  TICKET_CHECKED_IN: 'Checked in',
};

/** "BOOKING_CONFIRMED" -> "Booking confirmed", with a plain fallback for any other type. */
export function messageName(type: string): string {
  if (MESSAGE[type]) return MESSAGE[type];
  const words = type.toLowerCase().split('_').filter(Boolean);
  return words.length ? words[0][0].toUpperCase() + words.join(' ').slice(1) : type;
}

/** Newest first. Nothing is hidden: a resend or a second payment attempt is its own row. */
export function orderMessages(rows: AdminNotificationRow[]): AdminNotificationRow[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
