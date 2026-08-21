import { Injectable } from '@nestjs/common';
import { NotificationType } from '@eticketsgo/shared-types';

/** The rendered pieces of a notification message. */
export interface RenderedTemplate {
  subject: string;
  body: string;
}

type PayloadFn = (p: Record<string, unknown>) => RenderedTemplate;
type LocaleTemplates = Partial<Record<NotificationType, PayloadFn>>;

/** Default locale used when a requested locale has no template set. */
const DEFAULT_LOCALE = 'en';

/** Reads a payload field as a printable string, with a fallback. */
function str(p: Record<string, unknown>, key: string, fallback = ''): string {
  const v = p[key];
  return v === undefined || v === null ? fallback : String(v);
}

/**
 * English templates for every NotificationType. Kept pure and synchronous so
 * they can be rendered anywhere (send path, scheduled dispatch, tests).
 */
const EN: LocaleTemplates = {
  [NotificationType.BOOKING_CONFIRMED]: (p) => ({
    subject: 'Your booking is confirmed',
    body: `Your booking ${str(p, 'bookingId', '')} is confirmed for ${str(p, 'tickets', '0')} ticket(s).`,
  }),
  [NotificationType.PAYMENT_FAILED]: (p) => ({
    subject: 'Payment failed',
    body: `We could not process the payment for booking ${str(p, 'bookingId', '')}. Please try again.`,
  }),
  [NotificationType.EVENT_REMINDER]: (p) => ({
    subject: 'Reminder: your event is coming up',
    body: `This is a reminder for ${str(p, 'eventName', 'your event')}${
      p['startsAt'] ? ` starting at ${str(p, 'startsAt')}` : ''
    }.`,
  }),
  [NotificationType.BOOKING_CANCELLED]: (p) => ({
    subject: 'Your booking was cancelled',
    body: `Your booking ${str(p, 'bookingId', '')} has been cancelled.`,
  }),
  [NotificationType.REFUND_COMPLETED]: (p) => ({
    subject: 'Your refund is complete',
    body: `A refund of ${str(p, 'amountMinor', '0')} (minor units) for booking ${str(
      p,
      'bookingId',
      '',
    )} has been completed.`,
  }),
  [NotificationType.TICKET_CHECKED_IN]: (p) => ({
    subject: 'Ticket checked in',
    body: `Ticket ${str(p, 'serial', str(p, 'ticketId', ''))} has been checked in.`,
  }),
  [NotificationType.ATTENDEE_INVITED]: (p) => ({
    subject: 'You’ve been given a ticket',
    body: `You have been invited to claim a ticket${
      p['ref'] ? ` (${str(p, 'ref')})` : ''
    }. Open the link to accept it into your wallet.`,
  }),
  [NotificationType.ATTENDEE_ACCEPTED]: (p) => ({
    subject: 'Your ticket was claimed',
    body: `${str(p, 'attendee', 'The attendee')} has accepted the ticket you shared.`,
  }),
  [NotificationType.ATTENDEE_DECLINED]: (p) => ({
    subject: 'A ticket invitation was declined',
    body: `An invitation for ticket ${str(p, 'ticketId', '')} was declined; the ticket is yours to reassign.`,
  }),
  [NotificationType.TICKET_TRANSFERRED]: (p) => ({
    subject: 'Ticket transferred',
    body: `Ticket ${str(p, 'ticketId', '')} has been transferred to a new holder.`,
  }),
  [NotificationType.SHARE_CREATED]: (p) => ({
    subject: 'Someone shared an experience with you',
    body: `You’ve been sent ${str(p, 'permission', 'view')} access. Open the link to view it: ${str(p, 'url', '')}`,
  }),
  [NotificationType.SHARE_VIEWED]: (p) => ({
    subject: 'Your shared link was opened',
    body: `A share link for ticket ${str(p, 'ticketId', '')} was just opened.`,
  }),
  [NotificationType.SHARE_REVOKED]: (p) => ({
    subject: 'Share access revoked',
    body: `Access to ticket ${str(p, 'ticketId', '')} has been revoked.`,
  }),

  /*
    Onboarding and approval.

    Every one of these names the thing waiting and who it is waiting on. Without a template
    the generic fallback renders the raw payload as JSON — technically a notification, and
    useless as an email to a person deciding whether a business may sell tickets.
  */
  [NotificationType.ORGANIZATION_REGISTERED]: (p) => ({
    subject: `New organizer awaiting approval: ${str(p, 'organizationName', 'an organization')}`,
    body:
      `${str(p, 'organizationName', 'An organization')} has registered and is waiting for review. ` +
      `Contact: ${str(p, 'contactEmail', 'not provided')}. ` +
      `They cannot sell tickets until an admin approves them.`,
  }),
  [NotificationType.ORGANIZATION_APPROVED]: (p) => ({
    subject: `${str(p, 'organizationName', 'Your organization')} is approved`,
    body:
      `${str(p, 'organizationName', 'Your organization')} has been approved and can now sell tickets. ` +
      `Set up your venue, screens and showtimes in the organizer console.`,
  }),
  [NotificationType.ORGANIZATION_REJECTED]: (p) => ({
    subject: `${str(p, 'organizationName', 'Your organization')} was not approved`,
    body:
      `${str(p, 'organizationName', 'Your organization')} has not been approved.` +
      // The reason is the whole value of this message: "rejected" with no cause leaves
      // somebody unable to act, and support answering the same question every time.
      (str(p, 'reason') ? ` Reason: ${str(p, 'reason')}.` : '') +
      ` Contact support if you would like to discuss it.`,
  }),
  [NotificationType.EVENT_SUBMITTED]: (p) => ({
    subject: `Event awaiting review: ${str(p, 'eventTitle', 'an event')}`,
    body:
      `${str(p, 'organizationName', 'An organizer')} submitted "${str(p, 'eventTitle', 'an event')}" ` +
      `for review. It cannot go on sale until an admin approves it.`,
  }),
  [NotificationType.EVENT_APPROVED]: (p) => ({
    subject: `"${str(p, 'eventTitle', 'Your event')}" is approved`,
    body: `"${str(p, 'eventTitle', 'Your event')}" has been approved and is now published.`,
  }),
  [NotificationType.EVENT_REJECTED]: (p) => ({
    subject: `"${str(p, 'eventTitle', 'Your event')}" needs changes`,
    body:
      `"${str(p, 'eventTitle', 'Your event')}" was not approved.` +
      (str(p, 'reason') ? ` Reason: ${str(p, 'reason')}.` : '') +
      ` Make the changes and submit it again.`,
  }),
};

/** Registry of templates keyed by locale. Add locales here as they land. */
const TEMPLATES: Record<string, LocaleTemplates> = {
  [DEFAULT_LOCALE]: EN,
};

/**
 * Renders notification subject/body from a (type, locale, payload). Falls back
 * to the `en` locale when the requested locale is missing, and to a generic
 * template when a type has no entry.
 */
@Injectable()
export class NotificationTemplateService {
  render(
    type: NotificationType,
    locale: string,
    payload: Record<string, unknown>,
  ): RenderedTemplate {
    const table = TEMPLATES[locale] ?? TEMPLATES[DEFAULT_LOCALE];
    const fn = table?.[type] ?? TEMPLATES[DEFAULT_LOCALE]?.[type];
    if (fn) return fn(payload);
    return this.generic(type, payload);
  }

  /** Generic fallback for unknown/unmapped notification types. */
  private generic(type: NotificationType, payload: Record<string, unknown>): RenderedTemplate {
    return {
      subject: `Notification: ${type}`,
      body: `You have a new notification (${type}). ${JSON.stringify(payload)}`,
    };
  }
}
