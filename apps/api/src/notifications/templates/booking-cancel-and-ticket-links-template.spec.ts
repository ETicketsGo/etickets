import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from './notification-template.service';
import { buildEmailView } from './email-view';
import { renderEmailHtml } from './email-html';

/**
 * The words and the button for the two gaps the owner reported (2026-10-20):
 *
 *   - an account holder's confirmation had nothing to press; it now says where the tickets are
 *     and carries a "View my tickets" button to the booking's tickets page;
 *   - a booking the buyer cancelled was never announced; BOOKING_CANCELLED now names the
 *     booking, the show and when, and says plainly that a free booking has nothing to refund.
 *
 * And the two that must NOT move: the guest confirmation, and the paid show cancellation.
 */
const service = new NotificationTemplateService();
const SITE = 'https://shop.walk.eticketsgo.com';
const TICKETS = `${SITE}/account/bookings/bk-1/tickets`;
const GUEST_LINK = `${SITE}/booking/access/abc123TOKEN`;

const CONFIRMED = {
  bookingId: 'bk-1',
  reference: 'ETG-IND-2026-000123',
  eventTitle: 'Kantara',
  startsAt: '2026-12-20T13:30:00.000Z',
  timeZone: 'Asia/Kolkata',
  seats: 'H1, H2',
  tickets: 2,
};

function email(type: NotificationType, locale: string, payload: Record<string, unknown>) {
  const { subject, body } = service.render(type, locale, payload);
  const html = renderEmailHtml(
    buildEmailView({ type, locale, subject, body, payload, helpUrl: `${SITE}/help` }),
  );
  return { subject, body, html };
}

describe("an account holder's confirmation", () => {
  const ACCOUNT = { ...CONFIRMED, link: TICKETS, linkTo: 'ACCOUNT_TICKETS' };

  it.each([
    ['en', 'See your tickets in your account:', 'View my tickets'],
    ['fr-CA', 'Consultez vos billets dans votre compte :', 'Voir mes billets'],
  ])('says where the tickets are and carries the button to them (%s)', (locale, line, cta) => {
    const { subject, body, html } = email(NotificationType.BOOKING_CONFIRMED, locale, ACCOUNT);
    // The plain-text part, for readers and clients without HTML.
    expect(body).toContain(`${line} ${TICKETS}`);
    // It is not the guest's sentence: an account holder signs in.
    expect(body).not.toMatch(/no account needed|aucun compte requis/);
    // The HTML part: one button to the right host and booking.
    expect(html).toContain(`href="${TICKETS}"`);
    expect(html).toContain(cta);
    expect(subject).not.toContain('http');
  });
});

describe("a guest's confirmation is unchanged", () => {
  it.each([
    ['en', `Open your tickets here, no account needed: ${GUEST_LINK}`],
    ['fr-CA', `Consultez vos billets ici, aucun compte requis : ${GUEST_LINK}`],
  ])('keeps its access-link sentence and button (%s)', (locale, line) => {
    const { body, html } = email(NotificationType.BOOKING_CONFIRMED, locale, {
      ...CONFIRMED,
      link: GUEST_LINK,
    });
    expect(body.endsWith(line)).toBe(true);
    expect(body).not.toMatch(/in your account|dans votre compte/);
    expect(html).toContain(`href="${GUEST_LINK}"`);
  });

  it('renders the same body it rendered before the account link existed', () => {
    // Pinned to the exact text, so any drift in the guest sentence fails here.
    const { body } = service.render(NotificationType.BOOKING_CONFIRMED, 'en', {
      ...CONFIRMED,
      link: GUEST_LINK,
    });
    expect(body).toMatch(
      new RegExp(
        '^2 tickets confirmed for Kantara on .+\\. Seats H1, H2\\. Booking reference ' +
          `ETG-IND-2026-000123\\. Open your tickets here, no account needed: ${GUEST_LINK}$`,
      ),
    );
  });
});

describe('BOOKING_CANCELLED', () => {
  const CANCELLED = {
    bookingId: 'bk-1',
    reference: 'ETG-IND-2026-000123',
    eventTitle: 'Kantara',
    startsAt: '2026-12-20T13:30:00.000Z',
    timeZone: 'Asia/Kolkata',
    refundStatus: 'NOTHING_TO_REFUND',
  };

  it.each([
    ['en', 'Your booking was cancelled', 'Its tickets no longer work.', 'nothing to refund'],
    [
      'fr-CA',
      'Votre réservation a été annulée',
      'Ses billets ne sont plus valides.',
      'rien à rembourser',
    ],
  ])('names the booking, the show and when, and the money (%s)', (locale, subj, line, money) => {
    const { subject, body, html } = email(NotificationType.BOOKING_CANCELLED, locale, CANCELLED);
    expect(subject).toBe(subj);
    expect(body).toContain('ETG-IND-2026-000123');
    expect(body).toContain('Kantara');
    expect(body).toMatch(/20 (déc|Dec)/);
    expect(body).toContain(line);
    expect(body).toContain(money);
    expect(body).not.toMatch(/[{}]|undefined/);
    expect(html).toContain('ETG-IND-2026-000123');
  });

  it('still reads as a sentence for a row queued with only a reference', () => {
    const { body } = service.render(NotificationType.BOOKING_CANCELLED, 'en', {
      reference: 'ETG-IND-2026-000123',
    });
    expect(body).toBe(
      'Your booking ETG-IND-2026-000123 has been cancelled. Its tickets no longer work.',
    );
  });
});

describe('SHOW_CANCELLED', () => {
  const SHOW = {
    bookingId: 'bk-1',
    reference: 'ETG-IND-2026-000123',
    eventTitle: 'Kantara',
    startsAt: '2026-12-20T13:30:00.000Z',
    timeZone: 'Asia/Kolkata',
  };

  it.each(['en', 'fr-CA'])('does not promise a refund on a free booking (%s)', (locale) => {
    const free = service.render(NotificationType.SHOW_CANCELLED, locale, {
      ...SHOW,
      refundStatus: 'NOTHING_TO_REFUND',
    });
    expect(free.body).toMatch(/nothing to refund|rien à rembourser/);
    expect(free.body).not.toMatch(/A refund will follow|Un remboursement suivra/);
  });

  it.each(['en', 'fr-CA'])('still promises one to an online buyer (%s)', (locale) => {
    const paid = service.render(NotificationType.SHOW_CANCELLED, locale, SHOW);
    expect(paid.body).toMatch(/A refund will follow|Un remboursement suivra/);
  });

  it('keeps the cash wording for a counter sale', () => {
    const cash = service.render(NotificationType.SHOW_CANCELLED, 'en', {
      ...SHOW,
      paidInCash: true,
      amountMinor: 50_000,
      currency: 'INR',
    });
    expect(cash.body).toContain('in cash at the counter');
  });
});
