import { MARKETS } from '@eticketsgo/shared-types';
import { BookingReferenceService } from './booking-reference.service';

describe('BookingReferenceService', () => {
  const svc = new BookingReferenceService();

  describe('countryCode', () => {
    it('maps known countries to ISO alpha-3 (case/space-insensitive)', () => {
      expect(svc.countryCode('India')).toBe('IND');
      expect(svc.countryCode(' united kingdom ')).toBe('GBR');
      expect(svc.countryCode('USA')).toBe('USA');
      expect(svc.countryCode('Australia')).toBe('AUS');
      expect(svc.countryCode('United Arab Emirates')).toBe('ARE');
    });

    // QA 2026-10-17: a Bengaluru venue stored as "IN" printed ETG-INT-2026-000001 on tickets.
    it('reads a market stored by its two-letter code, as venues are saved', () => {
      expect(svc.countryCode('IN')).toBe('IND');
      expect(svc.countryCode(' in ')).toBe('IND');
      expect(svc.countryCode('US')).toBe('USA');
      expect(svc.countryCode('CA')).toBe('CAN');
      expect(svc.countryCode('GB')).toBe('GBR');
      expect(svc.countryCode('NZ')).toBe('NZL');
      expect(svc.countryCode('New Zealand')).toBe('NZL');
    });

    it('has an alpha-3 code for every market, so no market ever prints INT', () => {
      for (const market of MARKETS) {
        expect(svc.countryCode(market.code)).toMatch(/^[A-Z]{3}$/);
        expect(svc.countryCode(market.code)).not.toBe('INT');
        expect(svc.countryCode(market.name)).toBe(svc.countryCode(market.code));
      }
    });

    it('falls back to INT for unknown or missing countries (future regions)', () => {
      expect(svc.countryCode('Atlantis')).toBe('INT');
      expect(svc.countryCode(null)).toBe('INT');
      expect(svc.countryCode(undefined)).toBe('INT');
    });
  });

  describe('assign', () => {
    it('formats ETG-<COUNTRY>-<YEAR>-<seq> and increments the per-scope counter', async () => {
      const upsert = jest.fn().mockResolvedValue({ scope: 'IND-2026', value: 1 });
      const tx = { bookingReferenceCounter: { upsert } };

      const ref = await svc.assign(tx as never, {
        country: 'India',
        at: new Date('2026-03-04T00:00:00.000Z'),
      });

      expect(ref).toBe('ETG-IND-2026-000001');
      expect(upsert).toHaveBeenCalledWith({
        where: { scope: 'IND-2026' },
        create: { scope: 'IND-2026', value: 1 },
        update: { value: { increment: 1 } },
      });
    });

    it('zero-pads to six but does not truncate large sequences', async () => {
      const tx = {
        bookingReferenceCounter: { upsert: jest.fn().mockResolvedValue({ value: 1234567 }) },
      };
      const ref = await svc.assign(tx as never, {
        country: 'United States',
        at: new Date('2027-01-01T00:00:00.000Z'),
      });
      expect(ref).toBe('ETG-USA-2027-1234567');
    });

    it('scopes a venue stored as "IN" under IND, not INT', async () => {
      const upsert = jest.fn().mockResolvedValue({ value: 57 });
      const ref = await svc.assign({ bookingReferenceCounter: { upsert } } as never, {
        country: 'IN',
        at: new Date('2026-10-18T00:26:43.000Z'),
      });
      expect(ref).toBe('ETG-IND-2026-000057');
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { scope: 'IND-2026' } }),
      );
    });

    it('scopes unknown countries under INT', async () => {
      const upsert = jest.fn().mockResolvedValue({ value: 3 });
      await svc.assign({ bookingReferenceCounter: { upsert } } as never, {
        country: 'Narnia',
        at: new Date('2026-06-01T00:00:00.000Z'),
      });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { scope: 'INT-2026' } }),
      );
    });
  });
});
