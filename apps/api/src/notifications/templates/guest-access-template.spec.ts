import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from './notification-template.service';

/**
 * The link is a credential, and the message it travels in has to survive every payload.
 *
 * ── THE TWO WAYS THIS BREAKS SILENTLY ──────────────────────────────────────────────
 * A confirmation email is rendered from a row that may have been queued minutes or weeks
 * earlier, by a version of the producer that had never heard of a guest link. If the template
 * required one, every one of those rows would render with `{link}` printed literally or a hole
 * where a sentence should be — on the one message that carries somebody's tickets.
 *
 * And the credential must not reach the SUBJECT. A subject is what shows on a locked screen, in
 * a notification preview, and in the mail client of whoever is looking over a shoulder.
 */

const service = new NotificationTemplateService();

const CONFIRMED = {
  reference: 'ETG-IND-2026-000123',
  eventTitle: 'Kantara',
  startsAt: '2026-09-20T13:30:00.000Z',
  timeZone: 'Asia/Kolkata',
  seats: 'H1, H2',
  tickets: 2,
};

const LINK = 'https://tickets.example.com/booking/access/abc123TOKEN';

describe('the confirmation renders with or without a guest link', () => {
  it.each(['en', 'fr-CA'] as const)('includes the link for a guest booking (%s)', (locale) => {
    const { subject, body } = service.render(NotificationType.BOOKING_CONFIRMED, locale, {
      ...CONFIRMED,
      link: LINK,
    });
    expect(body).toContain(LINK);
    // Never the subject.
    expect(subject).not.toContain(LINK);
    expect(subject).not.toContain('booking/access');
  });

  it.each(['en', 'fr-CA'] as const)(
    'reads as a sentence when there is no link at all (%s)',
    (locale) => {
      // An account booking, and every row queued before the field existed.
      const { body } = service.render(NotificationType.BOOKING_CONFIRMED, locale, CONFIRMED);
      expect(body).not.toContain('{link}');
      expect(body).not.toContain('undefined');
      expect(body.trim().endsWith('.')).toBe(true);
      expect(body).toContain(CONFIRMED.reference);
    },
  );

  it('treats an empty link the same as no link', () => {
    // A producer that sets `link: ''` has supplied the key and none of the information; the
    // rendered sentence must be identical either way.
    const blank = service.render(NotificationType.BOOKING_CONFIRMED, 'en', {
      ...CONFIRMED,
      link: '',
    });
    const absent = service.render(NotificationType.BOOKING_CONFIRMED, 'en', CONFIRMED);
    expect(blank.body).toBe(absent.body);
  });
});

describe('the recovery email is about one thing', () => {
  it.each(['en', 'fr-CA'] as const)('carries the link in the body only (%s)', (locale) => {
    const { subject, body } = service.render(NotificationType.GUEST_BOOKING_ACCESS, locale, {
      link: LINK,
    });
    expect(body).toContain(LINK);
    expect(subject).not.toContain(LINK);
    expect(subject).not.toContain('access');
    // It says nothing about what was booked: the address that receives it may be the only
    // thing verified about the person who asked.
    expect(body).not.toContain('Kantara');
  });

  it('is translated rather than falling back to English', () => {
    const en = service.render(NotificationType.GUEST_BOOKING_ACCESS, 'en', { link: LINK });
    const fr = service.render(NotificationType.GUEST_BOOKING_ACCESS, 'fr-CA', { link: LINK });
    expect(fr.subject).not.toBe(en.subject);
    expect(fr.body).not.toBe(en.body);
  });
});
