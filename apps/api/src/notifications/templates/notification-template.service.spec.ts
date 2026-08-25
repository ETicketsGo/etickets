import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from './notification-template.service';

describe('NotificationTemplateService', () => {
  const svc = new NotificationTemplateService();

  it('renders a non-empty subject and body for every NotificationType (en)', () => {
    const payload = {
      bookingId: 'bk-1',
      tickets: 2,
      amountMinor: 5000,
      serial: 'TKT-1',
      ticketId: 'tk-1',
      eventName: 'Jazz Night',
      startsAt: '2026-08-01T20:00:00Z',
    };
    for (const type of Object.values(NotificationType)) {
      const out = svc.render(type, 'en', payload);
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.body.length).toBeGreaterThan(0);
    }
  });

  it('interpolates payload fields into the body', () => {
    // With no reference on the payload the id is still the fallback — see the readability
    // suite below for what a real, referenced booking now says.
    const out = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
      bookingId: 'bk-42',
      tickets: 3,
    });
    expect(out.body).toContain('bk-42');
    expect(out.body).toContain('3');
  });

  /*
    Reported from QA: the confirmation read "Your booking cmt83vftr007l912we33eldkp is
    confirmed for 2 ticket(s)." A cuid is a database identity — meaningless to the buyer,
    unreadable down a phone to support, and absent from their receipt.
  */
  describe('a customer can read what they are sent', () => {
    it('names the booking by its public reference, not its database id', () => {
      const out = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
        bookingId: 'cmt83vftr007l912we33eldkp',
        reference: 'ETG-IND-2026-000123',
        eventTitle: 'Movie 1',
        tickets: 2,
      });
      expect(out.body).toContain('ETG-IND-2026-000123');
      expect(out.body).not.toContain('cmt83vftr007l912we33eldkp');
    });

    it('names the event, the seats and the time', () => {
      const out = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
        reference: 'ETG-IND-2026-000123',
        eventTitle: 'Movie 1',
        startsAt: '2026-08-25T15:58:00.000Z',
        seats: 'A1, A2',
        tickets: 2,
      });
      expect(out.subject).toContain('Movie 1');
      expect(out.body).toContain('2 tickets');
      expect(out.body).toContain('Seats A1, A2');
      expect(out.body).toContain('25 Aug 2026');
    });

    it('still reads as a sentence when a queued older payload lacks the new fields', () => {
      // Messages scheduled before this change carry only bookingId and tickets. They must
      // degrade to a shorter sentence, not one with holes in it.
      const out = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
        bookingId: 'bk-42',
        tickets: 1,
      });
      expect(out.body).toContain('1 ticket confirmed');
      expect(out.body).toContain('bk-42');
      expect(out.body).not.toContain('undefined');
      expect(out.body).not.toMatch(/\son\s\./);
    });

    /*
      Reported from QA: the ticket said 9:28 pm and the notification said 8:58 am the next
      day. Both rendered the same instant — the pages use the reader's browser zone, and this
      template had Asia/Kolkata hardcoded. A showtime is not a fact about the reader.
    */
    it('quotes the time at the VENUE, and names the zone', () => {
      const out = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
        reference: 'ETG-IND-2026-000011',
        eventTitle: 'Movie 1',
        startsAt: '2026-08-26T03:28:00.000Z',
        timeZone: 'Asia/Kolkata',
        tickets: 2,
      });
      expect(out.body).toContain('26 Aug 2026');
      expect(out.body).toContain('8:58');
      // Unlabelled is the ambiguity that produced the report in the first place.
      expect(out.body).toMatch(/\((GMT\+5:30|IST)\)/);
    });

    it('renders the same instant differently for a venue in another zone', () => {
      // The property that matters: the clock follows the cinema, not the server.
      const at = '2026-08-26T03:28:00.000Z';
      const ist = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
        startsAt: at,
        timeZone: 'Asia/Kolkata',
        tickets: 1,
      }).body;
      const chicago = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
        startsAt: at,
        timeZone: 'America/Chicago',
        tickets: 1,
      }).body;
      expect(ist).not.toBe(chicago);
      expect(ist).toContain('26 Aug 2026');
      expect(chicago).toContain('25 Aug 2026');
    });

    it('falls back to UTC and says so rather than guessing the server zone', () => {
      const out = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
        startsAt: '2026-08-26T03:28:00.000Z',
        tickets: 1,
      });
      expect(out.body).toContain('(UTC)');
    });

    it('survives an unresolvable timezone rather than losing the confirmation', () => {
      const out = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
        startsAt: '2026-08-26T03:28:00.000Z',
        timeZone: 'Mars/Olympus_Mons',
        tickets: 1,
      });
      expect(out.body).toContain('(UTC)');
      expect(out.body).toContain('1 ticket confirmed');
    });

    it('shows a refund as money, not as minor units', () => {
      const out = svc.render(NotificationType.REFUND_COMPLETED, 'en', {
        reference: 'ETG-IND-2026-000123',
        amountMinor: 31600,
        currency: 'INR',
      });
      expect(out.body).toContain('₹316');
      expect(out.body).not.toContain('minor units');
      expect(out.body).not.toContain('31600');
    });

    it('pluralises rather than printing "1 ticket(s)"', () => {
      const one = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', { tickets: 1 });
      const two = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', { tickets: 2 });
      expect(one.body).toContain('1 ticket ');
      expect(two.body).toContain('2 tickets');
      expect(one.body).not.toContain('(s)');
    });
  });

  it('falls back to en when the requested locale is missing', () => {
    const enOut = svc.render(NotificationType.REFUND_COMPLETED, 'en', { bookingId: 'bk-9' });
    const frOut = svc.render(NotificationType.REFUND_COMPLETED, 'fr', { bookingId: 'bk-9' });
    expect(frOut).toEqual(enOut);
  });

  it('falls back to a generic template for an unknown type', () => {
    const out = svc.render('MYSTERY_TYPE' as NotificationType, 'en', { foo: 'bar' });
    expect(out.subject).toContain('MYSTERY_TYPE');
    expect(out.body).toContain('bar');
  });
});
