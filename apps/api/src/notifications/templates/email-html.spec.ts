import { NotificationType } from '@eticketsgo/shared-types';
import { buildEmailView } from './email-view';
import { renderEmailHtml } from './email-html';

/**
 * The HTML people actually receive.
 *
 * A transactional email is the platform's only appearance inside somebody's inbox, and it is
 * read next to their bank's. These pin the parts that would embarrass us or endanger them:
 * that nothing from a payload can become markup or a script link, that the facts a message
 * is about are shown, that the message still sends when the layout cannot be built, and that
 * a French reader gets a French button in a document that says it is French.
 */
const BOOKING = {
  type: NotificationType.BOOKING_CONFIRMED,
  subject: 'Your tickets for Ilakathamafiliya',
  body: '2 tickets confirmed for Ilakathamafiliya on 29 Sept 2026, 9:00 pm (IST). Seats A1, A2. Booking reference ETG-IND-2026-000024. Open your tickets: https://qa.eticketsgo.com/booking/abc',
  payload: {
    eventTitle: 'Ilakathamafiliya',
    startsAt: '2026-09-29T15:30:00.000Z',
    timeZone: 'Asia/Kolkata',
    seats: 'A1, A2',
    reference: 'ETG-IND-2026-000024',
    link: 'https://qa.eticketsgo.com/booking/abc',
  },
  helpUrl: 'https://qa.eticketsgo.com/help',
};

const html = (over: Partial<typeof BOOKING> = {}) =>
  renderEmailHtml(buildEmailView({ locale: 'en', ...BOOKING, ...over }));

describe('the email a customer receives', () => {
  it('shows the facts of the booking as rows', () => {
    const out = html();
    expect(out).toContain('Booking reference');
    expect(out).toContain('ETG-IND-2026-000024');
    expect(out).toContain('Seats');
    expect(out).toContain('A1, A2');
    // The venue's clock, named — the same rule the sentence follows.
    // The zone abbreviation depends on the ICU data the runtime ships, so both spellings pass.
    expect(out).toMatch(/29 Sept? 2026, 9:00\s*pm \((IST|GMT\+5:30)\)/);
  });

  it('turns the link into one button and takes the bare URL out of the sentence', () => {
    const out = html();
    expect(out).toContain('View my tickets');
    expect(out).toContain('href="https://qa.eticketsgo.com/booking/abc"');
    // The reference is still in the mail, in the panel, and the dangling
    // "Open your tickets:" with nothing after it is gone.
    expect(out).toContain('ETG-IND-2026-000024');
    expect(out).not.toContain('Open your tickets');
  });

  it('escapes anything a payload put in it', () => {
    /*
      A payload is assembled by whichever service is sending. An event titled with a <script>
      tag must arrive as text in somebody's inbox, not as markup in a document rendered under
      this platform's name.
    */
    const out = html({
      subject: 'Your tickets for <script>alert(1)</script>',
      payload: { ...BOOKING.payload, eventTitle: '<img src=x onerror=alert(1)>' },
    });
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;script&gt;');
  });

  it('refuses a link that is not http(s)', () => {
    // `javascript:` in a mail under this platform's branding is a phishing primitive.
    const out = html({
      body: 'Open your tickets: javascript:alert(1)',
      payload: { ...BOOKING.payload, link: 'javascript:alert(1)' },
    });
    // It stays in the sentence as escaped text, which is inert; what must not exist is a link
    // or a button carrying it.
    expect(out).not.toContain('href="javascript:');
    expect(out).not.toContain('View my tickets');
  });

  it('says why the message arrived, and where to get help', () => {
    const out = html();
    expect(out).toContain('You are getting this email because of a booking');
    expect(out).toContain('https://qa.eticketsgo.com/help');
  });

  it('previews the lead and the facts that identify the booking, not the subject again', () => {
    const out = html();
    const preheader = /<div style="[^"]*display:none[^"]*">([\s\S]*?)<\/div>/.exec(out)?.[1] ?? '';
    expect(preheader).toContain('Your booking is confirmed');
    expect(preheader).toContain('Ilakathamafiliya');
    expect(preheader).not.toContain('Your tickets for Ilakathamafiliya');
  });

  it('shows a lead instead of a sentence that would repeat every row', () => {
    // The first draft printed "2 tickets confirmed for X on 29 Sept ... Seats A1, A2 ..."
    // immediately above a panel saying the same four things.
    const out = html();
    expect(out).toContain('Your booking is confirmed. Here are the details.');
    expect(out).not.toContain('2 tickets confirmed for');
  });

  it('keeps the sentence where it says more than a panel could', () => {
    // A failed payment has to explain itself: why, and what happens to any charge.
    const out = renderEmailHtml(
      buildEmailView({
        type: NotificationType.PAYMENT_FAILED,
        locale: 'en',
        subject: 'Payment failed for Ilakathamafiliya',
        body: 'Your payment of Rs 1,299 did not go through. We did not issue any tickets. If your bank shows a charge for this attempt, it will be reversed automatically.',
        payload: { eventTitle: 'Ilakathamafiliya', amountMinor: 129900, currency: 'INR' },
      }),
    );
    expect(out).toContain('it will be reversed automatically');
    expect(out).not.toContain('Booking reference');
  });

  it('is a complete document with one 600px card', () => {
    const out = html();
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('width="600"');
    expect(out).toContain('prefers-color-scheme: dark');
  });
});

describe('what each kind of message shows', () => {
  it('tells a guest nothing about what they bought', () => {
    /*
      This address was typed at a "find my booking" form and nothing has proved the person
      who typed it is the buyer. Naming the show would tell whoever reads that inbox what was
      bought, so the mail carries the way back in and nothing else.
    */
    const out = renderEmailHtml(
      buildEmailView({
        type: NotificationType.GUEST_BOOKING_ACCESS,
        locale: 'en',
        subject: 'Your booking link',
        body: 'Open your booking: https://qa.eticketsgo.com/booking/xyz',
        payload: { eventTitle: 'Ilakathamafiliya', link: 'https://qa.eticketsgo.com/booking/xyz' },
      }),
    );
    expect(out).not.toContain('Ilakathamafiliya');
    expect(out).toContain('View my tickets');
  });

  it('gives a password reset its own button and no booking detail', () => {
    const out = renderEmailHtml(
      buildEmailView({
        type: NotificationType.PASSWORD_RESET_REQUESTED,
        locale: 'en',
        subject: 'Reset your password',
        body: 'Use this link within 30 minutes: https://qa.eticketsgo.com/reset-password?token=t',
        payload: { link: 'https://qa.eticketsgo.com/reset-password?token=t', minutes: '30' },
      }),
    );
    expect(out).toContain('Set a new password');
    expect(out).not.toContain('Booking reference');
  });

  it('sends a message with no link at all rather than an empty button', () => {
    const out = renderEmailHtml(
      buildEmailView({
        type: NotificationType.PASSWORD_CHANGED,
        locale: 'en',
        subject: 'Your password was changed',
        body: 'Your password was changed. If this was not you, contact support now.',
        payload: {},
      }),
    );
    expect(out).toContain('Your password was changed');
    expect(out).not.toContain('<a href');
  });
});

describe('a French reader', () => {
  it('gets a French button in a document that says it is French', () => {
    const out = renderEmailHtml(
      buildEmailView({
        ...BOOKING,
        locale: 'fr-CA',
        subject: 'Vos billets pour Ilakathamafiliya',
        body: '2 billets confirmes. Reference ETG-IND-2026-000024.',
      }),
    );
    expect(out).toContain('<html lang="fr-CA">');
    expect(out).toContain('Voir mes billets');
    expect(out).toContain('Référence de réservation');
    expect(out).toContain('Vous recevez ce courriel');
  });

  it('falls back to English for a locale nobody translated', () => {
    const out = renderEmailHtml(buildEmailView({ ...BOOKING, locale: 'de-DE' }));
    expect(out).toContain('View my tickets');
  });
});
