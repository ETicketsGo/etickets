import {
  kolkataDay,
  parsePilotConfig,
  pilotSaleBlockers,
  type PilotEnv,
  type PilotSale,
} from './pilot-config';

/**
 * The pilot's rules on their own: how the variables are read, and what each one refuses.
 * The sale path's use of them is in pilot-sale-path.spec.ts.
 */
const PILOT: PilotEnv = {
  PILOT_MODE: 'on',
  PILOT_ALLOWED_ORGANIZATION_IDS: 'org-pilot',
  PILOT_MAX_ORDER_MINOR: '200000',
  PILOT_MAX_DAILY_SALES_MINOR: '2500000',
};

const SALE: PilotSale = {
  organizationId: 'org-pilot',
  reservedSeating: false,
  cinema: false,
  currency: 'INR',
  provider: 'razorpay',
  paymentMethod: 'ONLINE',
  totalMinor: 150_000,
  buyerEmails: ['buyer@example.test'],
};

describe('reading the pilot variables', () => {
  it('is off when PILOT_MODE is unset or off, whatever else is set', () => {
    expect(parsePilotConfig({})).toEqual({ mode: 'off' });
    expect(parsePilotConfig({ ...PILOT, PILOT_MODE: 'off' })).toEqual({ mode: 'off' });
    expect(parsePilotConfig({ ...PILOT, PILOT_MODE: ' OFF ' })).toEqual({ mode: 'off' });
  });

  it('reads the recommended pilot values, with INR, razorpay, GA only and auto-pause as defaults', () => {
    const c = parsePilotConfig(PILOT);
    expect(c).toEqual({
      mode: 'on',
      valid: true,
      limits: {
        organizationIds: ['org-pilot'],
        currencies: ['INR'],
        providers: ['razorpay'],
        gaOnly: true,
        maxOrderMinor: 200_000,
        maxDailySalesMinor: 2_500_000,
        buyerEmails: [],
        autoPause: true,
        webhookRejectThreshold: 3,
      },
    });
  });

  it.each([
    ['an empty organizer list', { PILOT_ALLOWED_ORGANIZATION_IDS: ' , ' }, /ORGANIZATION_IDS/],
    ['a missing organizer list', { PILOT_ALLOWED_ORGANIZATION_IDS: undefined }, /ORGANIZATION_IDS/],
    ['an order cap with a decimal point', { PILOT_MAX_ORDER_MINOR: '2000.00' }, /ORDER_MINOR/],
    ['an order cap in words', { PILOT_MAX_ORDER_MINOR: 'two thousand' }, /ORDER_MINOR/],
    ['a zero daily cap', { PILOT_MAX_DAILY_SALES_MINOR: '0' }, /DAILY_SALES_MINOR/],
    ['a missing daily cap', { PILOT_MAX_DAILY_SALES_MINOR: undefined }, /DAILY_SALES_MINOR/],
    ['a typo in PILOT_MODE', { PILOT_MODE: 'yes' }, /PILOT_MODE/],
    ['a typo in PILOT_GA_ONLY', { PILOT_GA_ONLY: 'maybe' }, /PILOT_GA_ONLY/],
    ['an empty currency list', { PILOT_ALLOWED_CURRENCIES: '' }, /CURRENCIES/],
    ['a buyer entry that is not an address', { PILOT_ALLOWED_BUYER_EMAILS: 'owner' }, /BUYER/],
    ['a zero webhook threshold', { PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD: '0' }, /THRESHOLD/],
  ])('fails CLOSED on %s: on, not valid, and every sale refused', (_l, over, problem) => {
    const c = parsePilotConfig({ ...PILOT, ...over });
    expect(c.mode).toBe('on');
    expect(c).toMatchObject({ valid: false });
    if (c.mode === 'on' && !c.valid) expect(c.problems.join(' ')).toMatch(problem);
    expect(pilotSaleBlockers(c, SALE)).toEqual(['PILOT_MISCONFIGURED']);
  });

  it('never puts a buyer address in a problem sentence', () => {
    const c = parsePilotConfig({ ...PILOT, PILOT_ALLOWED_BUYER_EMAILS: 'owner@x.test,typo' });
    expect(JSON.stringify(c)).not.toMatch(/owner@x\.test|typo/);
  });

  it('keeps auto-pause on, and the organizer list, while misconfigured', () => {
    const c = parsePilotConfig({ ...PILOT, PILOT_MAX_ORDER_MINOR: 'x' });
    expect(c).toMatchObject({ autoPause: true, organizationIds: ['org-pilot'] });
  });
});

describe('what the pilot refuses', () => {
  const c = parsePilotConfig(PILOT);

  it('sells a small INR general-admission order for the pilot organizer', () => {
    expect(pilotSaleBlockers(c, SALE)).toEqual([]);
  });

  it.each<[string, Partial<PilotSale>, string]>([
    ['another organizer', { organizationId: 'org-other' }, 'PILOT_ORGANIZER_NOT_ALLOWED'],
    ['reserved seating', { reservedSeating: true }, 'PILOT_RESERVED_SEATING'],
    ['a cinema show', { cinema: true }, 'PILOT_RESERVED_SEATING'],
    ['dollars', { currency: 'USD', provider: 'stripe' }, 'PILOT_CURRENCY'],
    ['a provider other than Razorpay', { provider: 'mock' }, 'PILOT_PROVIDER'],
    ['cash at the venue', { paymentMethod: 'CASH' }, 'PILOT_PROVIDER'],
    ['an order over Rs 2,000', { totalMinor: 200_001 }, 'PILOT_ORDER_LIMIT'],
  ])('refuses %s', (_l, over, code) => {
    expect(pilotSaleBlockers(c, { ...SALE, ...over })).toContain(code);
  });

  it('takes exactly Rs 2,000', () => {
    expect(pilotSaleBlockers(c, { ...SALE, totalMinor: 200_000 })).toEqual([]);
  });

  it('does not ask a free order which provider would charge it', () => {
    expect(pilotSaleBlockers(c, { ...SALE, totalMinor: 0, provider: null })).toEqual([]);
  });

  it('leaves the order cap out of the before-price pass', () => {
    expect(pilotSaleBlockers(c, { ...SALE, totalMinor: 999_999 }, 'beforePrice')).toEqual([]);
  });

  it('allows any reserved-seating sale when PILOT_GA_ONLY=false', () => {
    const open = parsePilotConfig({ ...PILOT, PILOT_GA_ONLY: 'false' });
    expect(pilotSaleBlockers(open, { ...SALE, reservedSeating: true, cinema: true })).toEqual([]);
  });

  describe('the buyer allowlist', () => {
    const owner = parsePilotConfig({ ...PILOT, PILOT_ALLOWED_BUYER_EMAILS: 'Owner@Example.test' });

    it('lets the listed buyer through, whatever the case', () => {
      expect(pilotSaleBlockers(owner, { ...SALE, buyerEmails: ['owner@example.TEST'] })).toEqual(
        [],
      );
    });

    it('refuses everybody else', () => {
      expect(pilotSaleBlockers(owner, SALE)).toEqual(['PILOT_BUYER_NOT_ALLOWED']);
    });

    it('refuses a signed-in stranger who typed the owner address', () => {
      expect(
        pilotSaleBlockers(owner, {
          ...SALE,
          buyerEmails: ['owner@example.test', 'stranger@example.test'],
        }),
      ).toEqual(['PILOT_BUYER_NOT_ALLOWED']);
    });

    it('is not decided on a quote, which names no buyer', () => {
      expect(pilotSaleBlockers(owner, { ...SALE, buyerEmails: undefined })).toEqual([]);
    });
  });

  it('refuses nothing when pilot mode is off', () => {
    expect(
      pilotSaleBlockers(parsePilotConfig({}), {
        ...SALE,
        organizationId: 'x',
        reservedSeating: true,
        currency: 'USD',
        provider: 'stripe',
        totalMinor: 99_999_999,
      }),
    ).toEqual([]);
  });
});

describe('the pilot day', () => {
  it('is the Asia/Kolkata calendar day, which starts at 18:30 UTC', () => {
    const d = kolkataDay(new Date('2026-10-15T18:29:59Z'));
    expect(d.label).toBe('2026-10-15');
    expect(d.start.toISOString()).toBe('2026-10-14T18:30:00.000Z');
    expect(d.end.toISOString()).toBe('2026-10-15T18:30:00.000Z');
    expect(kolkataDay(new Date('2026-10-15T18:30:00Z')).label).toBe('2026-10-16');
  });
});
