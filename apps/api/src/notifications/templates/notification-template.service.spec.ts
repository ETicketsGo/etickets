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
    const out = svc.render(NotificationType.BOOKING_CONFIRMED, 'en', {
      bookingId: 'bk-42',
      tickets: 3,
    });
    expect(out.body).toContain('bk-42');
    expect(out.body).toContain('3');
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
