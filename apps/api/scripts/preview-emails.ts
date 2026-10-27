import * as fs from 'node:fs';
import * as path from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from '../src/notifications/templates/notification-template.service';
import { buildEmailView } from '../src/notifications/templates/email-view';
import { renderEmailHtml } from '../src/notifications/templates/email-html';
import {
  CAMPAIGN_TEMPLATES,
  TEMPLATE_KEYS,
  templateStart,
} from '../src/campaigns/campaign-content';
import { renderCampaignEmail } from '../src/campaigns/campaign-email';

/**
 * Writes every email to disk, in every language, so a person can look at them.
 *
 *   npm run email:preview            (writes to .email-preview/)
 *   npm run email:preview -- /tmp/x  (or anywhere else)
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * A mail template is the one piece of this platform that is never seen during development:
 * it is composed on a server, handed to a provider and rendered in somebody else's client.
 * The first render of this layout came out in Times New Roman, and no test would ever have
 * said so - the HTML was valid, every assertion passed, and it simply had no font-family.
 *
 * So: no sending, no provider, no account. It renders the same functions the worker calls
 * and leaves the files in a folder to be opened in a browser. Reviewing a change to the
 * layout means looking at it, which is the only way this class of defect is ever found.
 */
const OUT = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '.email-preview'));

/** A plausible payload per type. Fiction, but the same SHAPE the producers send. */
const EVENT = {
  eventTitle: 'Ilakathamafiliya',
  startsAt: '2026-09-29T15:30:00.000Z',
  timeZone: 'Asia/Kolkata',
  seats: 'A1, A2',
  reference: 'ETG-IND-2026-000024',
  tickets: 2,
  currency: 'INR',
};

/** A case is a type and a payload, with a name when one type has several readers. */
const CASES: [NotificationType, Record<string, unknown>, string?][] = [
  // A guest: the link is their access link, and no account is needed.
  [
    NotificationType.BOOKING_CONFIRMED,
    { ...EVENT, link: 'https://qa.eticketsgo.com/booking/access/abc' },
    'BOOKING_CONFIRMED-guest',
  ],
  // An account holder: the link is the booking's tickets page, which asks them to sign in.
  [
    NotificationType.BOOKING_CONFIRMED,
    {
      ...EVENT,
      bookingId: 'cmbookingexample',
      link: 'https://qa.eticketsgo.com/account/bookings/cmbookingexample/tickets',
      linkTo: 'ACCOUNT_TICKETS',
    },
    'BOOKING_CONFIRMED-account',
  ],
  [NotificationType.EVENT_REMINDER, { ...EVENT }],
  [
    NotificationType.PAYMENT_FAILED,
    {
      ...EVENT,
      amountMinor: 129_900,
      reason: 'card_declined',
      link: 'https://qa.eticketsgo.com/checkout/abc',
    },
  ],
  [NotificationType.REFUND_REQUESTED, { ...EVENT, amountMinor: 129_900 }],
  [NotificationType.REFUND_COMPLETED, { ...EVENT, amountMinor: 129_900 }],
  [NotificationType.SHOW_CHANGED, { ...EVENT }],
  [NotificationType.SHOW_CANCELLED, { ...EVENT }],
  // A free booking on a cancelled show: no refund is promised.
  [
    NotificationType.SHOW_CANCELLED,
    { ...EVENT, refundStatus: 'NOTHING_TO_REFUND' },
    'SHOW_CANCELLED-free',
  ],
  // Paid in cash at the counter: the cash comes back at the venue, not as a refund.
  [
    NotificationType.SHOW_CANCELLED,
    { ...EVENT, paidInCash: true, amountMinor: 129_900 },
    'SHOW_CANCELLED-cash',
  ],
  // A walk-up cash sale with no buyer email: the organization is told whom to repay.
  [
    NotificationType.SHOW_CANCELLED,
    {
      ...EVENT,
      paidInCash: true,
      amountMinor: 129_900,
      cashRecipient: 'ORGANIZER',
      buyerName: 'Walk Counter Buyer',
    },
    'SHOW_CANCELLED-cash-organizer',
  ],
  // The buyer cancelled their own free booking: nothing was paid, so nothing is refunded.
  [NotificationType.BOOKING_CANCELLED, { ...EVENT, refundStatus: 'NOTHING_TO_REFUND' }],
  [NotificationType.TICKET_TRANSFERRED, { ...EVENT, ticketId: 'TKT-9931' }],
  [NotificationType.TICKET_CHECKED_IN, { ...EVENT, serial: 'TKT-9931' }],
  [
    NotificationType.PASSWORD_RESET_REQUESTED,
    { link: 'https://qa.eticketsgo.com/reset-password?token=example', minutes: 30 },
  ],
  [NotificationType.PASSWORD_CHANGED, {}],
  [NotificationType.GUEST_BOOKING_ACCESS, { link: 'https://qa.eticketsgo.com/booking/xyz' }],
  [
    NotificationType.ORGANIZATION_APPROVED,
    { organizationName: 'Bengaluru Live', link: 'https://organizer-qa.eticketsgo.com/organizer' },
  ],
  [
    NotificationType.EVENT_APPROVED,
    {
      eventTitle: 'Ilakathamafiliya',
      link: 'https://organizer-qa.eticketsgo.com/organizer/events',
    },
  ],
  [
    NotificationType.PAYOUT_ACCOUNT_UPDATED,
    {
      change: 'SAVED',
      currency: 'INR',
      bankName: 'HDFC Bank',
      accountLast4: '6789',
      version: 2,
      changedFields: ['accountNumber'],
    },
  ],
  [
    NotificationType.EVENT_REJECTED,
    { eventTitle: 'Ilakathamafiliya', reason: 'The poster is not licensed to this organizer.' },
  ],
  // The support mailbox's copy of a Contact form message, and the sender's acknowledgement.
  [
    NotificationType.SUPPORT_REQUEST_RECEIVED,
    {
      // The readable reference; the id rides along for tracing and no template shows it.
      reference: 'ETG-SUP-2026-000142',
      feedbackId: 'cmgsupport0000example',
      kind: 'CONTACT',
      topic: '[Support] Website enquiry',
      message:
        'From: Asha Rao\n\nI was charged twice for booking ETG-IND-2026-000024.\n' +
        'Can you check and refund one of them?\n\n<b>Thanks</b>',
      senderName: 'Asha Rao',
      replyTo: 'asha@example.com',
      accountEmail: '',
      organizationName: '',
      bookingReference: 'ETG-IND-2026-000024',
      link: 'https://admin.eticketsgo.com/admin/support?q=ETG-SUP-2026-000142',
    },
  ],
  [
    NotificationType.SUPPORT_REQUEST_ACKNOWLEDGED,
    {
      reference: 'ETG-SUP-2026-000142',
      feedbackId: 'cmgsupport0000example',
      email: 'asha@example.com',
    },
  ],
  [
    NotificationType.BILLING_PAYMENT_FAILED,
    {
      subscriptionId: 'cmgsubscription0example',
      stage: 'GRACE',
      planName: 'Pro',
      periodEnd: '2026-11-30T00:00:00.000Z',
      deadline: '2026-12-07',
    },
  ],
];

const HELP = 'https://qa.eticketsgo.com/help';
const templates = new NotificationTemplateService();

fs.mkdirSync(OUT, { recursive: true });
const index: string[] = [];

for (const locale of ['en', 'fr-CA'] as const) {
  for (const [type, payload, label = type] of CASES) {
    const rendered = templates.render(type, locale, payload);
    const html = renderEmailHtml(
      buildEmailView({
        type,
        locale,
        subject: rendered.subject,
        body: rendered.body,
        payload,
        helpUrl: HELP,
      }),
    );
    const name = `${locale}-${label}.html`;
    fs.writeFileSync(path.join(OUT, name), html);
    index.push(
      `<li><a href="${name}">${locale} &middot; ${label}</a><br /><span style="color:#6b7280">${rendered.subject}</span></li>`,
    );
  }
}

/*
  Organizer campaign templates: the same renderer the campaign worker calls, with a sample
  event and organizer. Links are shown as their targets; a real send routes them through the
  click tracker.
*/
const SAMPLE_EVENT = {
  id: 'evt_sample',
  title: 'Ilakathamafiliya',
};
for (const locale of ['en', 'fr-CA'] as const) {
  for (const key of TEMPLATE_KEYS) {
    const start = templateStart(key, {
      event: CAMPAIGN_TEMPLATES[key].needsEvent ? SAMPLE_EVENT : null,
      organizer: 'Vijayawada Live',
    });
    const { html } = renderCampaignEmail({
      locale,
      subject: start.subject,
      previewText: start.previewText,
      blocks: start.content.blocks,
      purpose: start.purpose,
      organizer: { name: 'Vijayawada Live', logoUrl: null },
      mainEventImageUrl: null,
      events: {
        [SAMPLE_EVENT.id]: {
          title: SAMPLE_EVENT.title,
          when: 'Tue 29 Sept 2026, 9:00 pm IST',
          venue: 'Siddhartha Auditorium, Vijayawada',
          imageUrl: null,
          bookUrl: 'https://qa.eticketsgo.com/events/ilakathamafiliya',
        },
      },
      link: (target) => target,
      unsubscribeUrl: 'https://qa.eticketsgo.com/unsubscribe/sample',
      platform: { legalName: 'DeepTrics Software Solutions Private Limited', postalAddress: null },
    });
    const name = `${locale}-CAMPAIGN-${key}.html`;
    fs.writeFileSync(path.join(OUT, name), html);
    index.push(
      `<li><a href="${name}">${locale} &middot; campaign &middot; ${key}</a><br /><span style="color:#6b7280">${start.subject}</span></li>`,
    );
  }
}

fs.writeFileSync(
  path.join(OUT, 'index.html'),
  `<!doctype html><meta charset="utf-8" /><title>Email previews</title>
   <body style="font:15px -apple-system,Segoe UI,Roboto,sans-serif;padding:28px;max-width:720px;">
   <h1>Email previews</h1>
   <p style="color:#6b7280">Rendered from the same functions the worker calls. Nothing was sent.</p>
   <ul style="line-height:1.9">${index.join('')}</ul>`,
);

console.log(`${index.length} emails written to ${OUT}`);
