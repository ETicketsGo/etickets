import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from './notification-template.service';
import { renderReceiptHtml } from '../../receipts/receipt-html';
import type { ReceiptDocument } from '../../receipts/receipt-document';

/**
 * A customer in Quebec is written to in French — email, and the receipt they keep.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────
 * Quebec's Charter of the French Language covers consumer commerce as a whole: the
 * storefront, the checkout, the invoice and the transactional email. A French storefront
 * that sends an English confirmation is not partial compliance — the email and the receipt
 * are the artefacts the customer keeps and the ones an inspector would ask for.
 *
 * `catalogue.test.ts` in `@eticketsgo/i18n` already proves no message is MISSING from a
 * locale. What it cannot prove is that the rendering path actually reaches for the right
 * one: a builder that ignores its `locale` argument, or a `lang` attribute left hardcoded,
 * passes a completeness check and still ships English to a French reader. That is what this
 * file checks, end to end, on the real renderers.
 */
const svc = new NotificationTemplateService();

const BOOKING = {
  tickets: 2,
  eventTitle: 'Festival de Jazz',
  reference: 'ETG-CAN-2026-000042',
  seats: 'A1, A2',
  startsAt: '2026-08-25T15:58:00.000Z',
  timeZone: 'America/Toronto',
};

describe('transactional email in French', () => {
  it('confirms a booking in French, not English with French punctuation', () => {
    const { subject, body } = svc.render(NotificationType.BOOKING_CONFIRMED, 'fr-CA', BOOKING);

    expect(subject).toBe('Vos billets pour Festival de Jazz');
    expect(body).toContain('billets');
    expect(body).toContain('Numéro de réservation ETG-CAN-2026-000042');
    // The give-away that a template was half-translated is an English connective left behind.
    expect(body).not.toMatch(/\b(confirmed|Booking reference|for|Seats)\b/);
  });

  it('agrees the plural with the count', () => {
    /*
      French and English pluralise at the same boundary here, but the FORMS differ, and a
      catalogue that interpolated a bare number would read "1 billets". The plural lives in
      the message rather than in the code precisely so a locale can disagree about it.
    */
    const one = svc.render(NotificationType.BOOKING_CONFIRMED, 'fr-CA', {
      ...BOOKING,
      tickets: 1,
    });
    expect(one.body).toContain('1 billet ');
    expect(one.body).not.toContain('1 billets');

    const many = svc.render(NotificationType.BOOKING_CONFIRMED, 'fr-CA', BOOKING);
    expect(many.body).toContain('2 billets');
  });

  it('writes money the Canadian French way', () => {
    /*
      `123,45 $` — comma decimal, symbol trailing. Not a nicety: an amount formatted
      `$123.45` on a French receipt is the single most visible sign that a page was
      translated rather than localised, and it is what `Intl` gets right for free once the
      locale is actually passed to it.
    */
    const { body } = svc.render(NotificationType.REFUND_COMPLETED, 'fr-CA', {
      amountMinor: 12_345,
      currency: 'CAD',
      reference: 'ETG-CAN-2026-000042',
    });
    expect(body).toContain('remboursement');
    expect(body).toMatch(/12\s?345,45\s?\$|123,45\s?\$/);
    expect(body).not.toContain('$123.45');
  });

  it('renders the date in French while keeping the VENUE clock', () => {
    /*
      Two different questions that are easy to conflate. The LANGUAGE follows the reader —
      "août", not "Aug". The CLOCK follows the venue — a show in Toronto starts when it
      starts, whoever is reading. Getting the second wrong is the bug that once had a ticket
      and its confirmation eleven and a half hours apart.
    */
    const { body } = svc.render(NotificationType.BOOKING_CONFIRMED, 'fr-CA', BOOKING);
    expect(body).toMatch(/août/);
    // 15:58 UTC is 11:58 in Toronto, and the zone is named rather than left to be guessed.
    expect(body).toMatch(/11:58|11 h 58/);
    expect(body).toMatch(/\(HAE\)|\(GMT-4\)|\(EDT\)/);
  });

  it('still renders English for an English reader', () => {
    // The whole feature is additive; the existing customer base must be untouched.
    const { subject, body } = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', BOOKING);
    expect(subject).toBe('Your tickets for Festival de Jazz');
    expect(body).toContain('Booking reference ETG-CAN-2026-000042');
  });

  it('falls back to English for a locale that no longer exists', () => {
    /*
      Reached from the scheduled dispatcher reading rows written months earlier. A locale
      that has since been retired must not cost somebody their booking confirmation.
    */
    const { subject } = svc.render(NotificationType.BOOKING_CONFIRMED, 'kl-KL', BOOKING);
    expect(subject).toBe('Your tickets for Festival de Jazz');
  });
});

const DOCUMENT: ReceiptDocument = {
  version: 1,
  kind: 'RECEIPT',
  number: 'RCT-2026-000042',
  issuedAt: new Date('2026-08-20T10:00:00.000Z').toISOString(),
  currency: 'CAD',
  seller: {
    name: 'Festival Inc.',
    legalName: 'Festival Incorporée',
    taxRegistrationKind: null,
    taxRegistrationNumber: null,
    address: { line1: '1 rue Sainte-Catherine', city: 'Montréal', country: 'Canada' },
  },
  buyer: { name: 'Marie Tremblay', email: 'marie@example.test' },
  order: {
    bookingId: 'bk-1',
    reference: 'ETG-CAN-2026-000042',
    eventTitle: 'Festival de Jazz',
    sessionStartsAt: null,
    venue: null,
  },
  lines: [
    {
      description: 'Admission générale',
      quantity: 2,
      unitPriceMinor: 5000,
      lineTotalMinor: 10_000,
    },
  ],
  taxLines: [],
  totals: { subtotalMinor: 10_000, discountMinor: 0, feeMinor: 0, taxMinor: 0, totalMinor: 10_000 },
  notes: [],
  reverses: null,
} as unknown as ReceiptDocument;

describe('the receipt in French', () => {
  it('translates every label on the document', () => {
    const html = renderReceiptHtml(DOCUMENT, 'fr-CA');

    expect(html).toContain('Reçu');
    expect(html).toContain('Facturé à');
    expect(html).toContain('Sous-total');
    expect(html).toContain('Total');
    // The labels an English reader would recognise must be gone, not merely accompanied.
    expect(html).not.toContain('Billed to');
    expect(html).not.toContain('Subtotal');
    expect(html).not.toContain('>Qty<');
  });

  it('declares its language, so a screen reader uses a French voice', () => {
    /*
      WCAG 3.1.1. A French document declaring `lang="en"` is read aloud by an English
      synthesiser and is genuinely unintelligible — worse than no language at all. This is
      also the criterion the site-wide accessibility sweep asserts on every page, and the
      receipt is the one HTML document that sweep cannot reach.
    */
    expect(renderReceiptHtml(DOCUMENT, 'fr-CA')).toContain('<html lang="fr-CA">');
    expect(renderReceiptHtml(DOCUMENT, 'en')).toContain('<html lang="en">');
  });

  it('writes the amounts in Canadian French', () => {
    const html = renderReceiptHtml(DOCUMENT, 'fr-CA');
    expect(html).toMatch(/100,00/);
    expect(html).not.toContain('$100.00');
  });

  it('leaves the English receipt exactly as it was', () => {
    const html = renderReceiptHtml(DOCUMENT);
    expect(html).toContain('Receipt');
    expect(html).toContain('Billed to');
    expect(html).toContain('<html lang="en">');
  });
});
