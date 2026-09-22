import * as fs from 'node:fs';
import * as path from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from '../src/notifications/templates/notification-template.service';
import { buildEmailView } from '../src/notifications/templates/email-view';
import { renderEmailHtml } from '../src/notifications/templates/email-html';

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

const CASES: [NotificationType, Record<string, unknown>][] = [
  [NotificationType.BOOKING_CONFIRMED, { ...EVENT, link: 'https://qa.eticketsgo.com/booking/abc' }],
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
  [NotificationType.BOOKING_CANCELLED, { ...EVENT }],
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
    NotificationType.EVENT_REJECTED,
    { eventTitle: 'Ilakathamafiliya', reason: 'The poster is not licensed to this organizer.' },
  ],
];

const HELP = 'https://qa.eticketsgo.com/help';
const templates = new NotificationTemplateService();

fs.mkdirSync(OUT, { recursive: true });
const index: string[] = [];

for (const locale of ['en', 'fr-CA'] as const) {
  for (const [type, payload] of CASES) {
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
    const name = `${locale}-${type}.html`;
    fs.writeFileSync(path.join(OUT, name), html);
    index.push(
      `<li><a href="${name}">${locale} &middot; ${type}</a><br /><span style="color:#6b7280">${rendered.subject}</span></li>`,
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
