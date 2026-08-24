import { FeeMode } from '@eticketsgo/shared-types';
import { AdvertisedPriceService } from './advertised-price.service';
import { DEFAULT_FEE_TIERS } from './fee-calculator';
import { advertisedPriceMinor, parsePriceDisplayMode } from './price-display';

/**
 * What a LISTING advertises.
 *
 * The requirement being served is about the number a buyer sees while deciding, not the
 * breakdown they see after deciding. A platform that itemises correctly at checkout and
 * advertises a bare ticket price on the browse page has complied with nothing — so these
 * tests are about listings, and the checkout breakdown is deliberately untouched.
 */

const svc = (mode?: string, rules: unknown[] = []) =>
  new AdvertisedPriceService(
    { feeRule: { findMany: jest.fn().mockResolvedValue(rules) } } as never,
    { get: () => mode } as never,
  );

describe('parsePriceDisplayMode', () => {
  it('defaults to itemised', () => {
    expect(parsePriceDisplayMode(undefined)).toBe('itemised');
    expect(parsePriceDisplayMode('')).toBe('itemised');
  });

  it('refuses an unrecognised value rather than guessing', () => {
    // Defaulting would advertise the wrong price in whichever market it was set for, and
    // do it silently. A boot failure is the cheaper mistake.
    expect(() => parsePriceDisplayMode('allin')).toThrow(/Unknown PRICE_DISPLAY_MODE/);
    expect(() => parsePriceDisplayMode('ALL_IN')).toThrow();
  });
});

describe('advertisedPriceMinor', () => {
  const base = {
    basePriceMinor: 100_000,
    feeMode: FeeMode.CUSTOMER_PAYS,
    tiers: DEFAULT_FEE_TIERS,
  };

  it('leaves the face price alone in itemised mode', () => {
    expect(advertisedPriceMinor({ ...base, mode: 'itemised' })).toBe(100_000);
  });

  it('includes mandatory customer-borne fees in all_in mode', () => {
    // ₹1000 ticket + ₹20 booking fee + 2% payment fee on ₹1020 = ₹1040.40
    expect(advertisedPriceMinor({ ...base, mode: 'all_in' })).toBe(104_040);
  });

  it('excludes fees the organizer absorbs, which are not charges to the buyer', () => {
    // Including them would overstate the advertised price — the opposite failure, and just
    // as wrong.
    expect(advertisedPriceMinor({ ...base, mode: 'all_in', feeMode: FeeMode.ORGANIZER_PAYS })).toBe(
      100_000,
    );
  });

  it('includes only the buyer half under a shared fee', () => {
    const shared = advertisedPriceMinor({ ...base, mode: 'all_in', feeMode: FeeMode.SHARED });
    expect(shared).toBeGreaterThan(100_000);
    expect(shared).toBeLessThan(104_040);
  });

  it('prices ONE ticket, because that is what "from ₹X" means', () => {
    // Booking fees are tiered on order value. Advertising a per-ticket share of a
    // multi-ticket order's fee would be a number no buyer could ever be charged.
    const one = advertisedPriceMinor({ ...base, mode: 'all_in' });
    const asIfTwo = advertisedPriceMinor({ ...base, basePriceMinor: 200_000, mode: 'all_in' }) / 2;
    expect(one).not.toBe(asIfTwo);
  });

  it('leaves a free ticket at zero', () => {
    expect(advertisedPriceMinor({ ...base, basePriceMinor: 0, mode: 'all_in' })).toBe(0);
  });
});

describe('AdvertisedPriceService', () => {
  it('is a pass-through by default and never touches the database', async () => {
    const findMany = jest.fn();
    const service = new AdvertisedPriceService(
      { feeRule: { findMany } } as never,
      { get: () => undefined } as never,
    );
    expect(service.isPassThrough).toBe(true);
    expect(await service.forTicket(79_900, FeeMode.CUSTOMER_PAYS, 'INR')).toBe(79_900);
    // The default costs nothing on the hottest path in the product.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('passes a null price through untouched', async () => {
    expect(await svc('all_in').forTicket(null, FeeMode.CUSTOMER_PAYS)).toBeNull();
  });

  it('adds the customer-borne fee in all_in mode', async () => {
    expect(await svc('all_in').forTicket(100_000, FeeMode.CUSTOMER_PAYS, 'INR')).toBe(104_040);
  });

  it('uses the configured fee rules for the currency when they exist', async () => {
    const service = svc('all_in', [{ minMinor: 0, maxMinor: null, feeMinor: 5_000 }]);
    // ₹1000 + ₹50 configured booking fee + 2% of ₹1050 = ₹1071
    expect(await service.forTicket(100_000, FeeMode.CUSTOMER_PAYS, 'INR')).toBe(107_100);
  });

  it('reads fee rules once per currency, not once per card', async () => {
    // A listing page renders dozens of cards. A query per card to compute an advertised
    // price would be a self-inflicted N+1 on the browse path.
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new AdvertisedPriceService(
      { feeRule: { findMany } } as never,
      { get: () => 'all_in' } as never,
    );
    for (let i = 0; i < 20; i++) await service.forTicket(50_000, FeeMode.CUSTOMER_PAYS, 'INR');
    await service.forTicket(50_000, FeeMode.CUSTOMER_PAYS, 'USD');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('refuses to construct on an unrecognised mode', () => {
    expect(() => svc('all-in')).toThrow(/Unknown PRICE_DISPLAY_MODE/);
  });
});
