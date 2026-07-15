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
