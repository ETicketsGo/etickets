import {
  ANNUAL_PRICE_MULTIPLIER,
  EntitlementKey,
  PROVISIONAL_MONTHLY_PRICES,
  PROVISIONAL_PLAN_ENTITLEMENTS,
} from '@eticketsgo/shared-types';
import { loadConfig } from '../config/configuration';
import {
  POSTAL_ADDRESS_PLACEHOLDER,
  campaignFooterAddress,
  campaignSendingConfig,
} from '../campaigns/campaign-sending-config';
import { unsubscribeKey } from '../engagement/unsubscribe-token';
import { EMAIL_CREDIT_PACKS, creditPackOffers } from './credit-packs';
import { indianFinancialYearStart, invoiceSeries } from './invoice-number';
import { scopeForReason } from '../notifications/delivery/suppression.service';

/**
 * The owner's product decisions of 2026-10-27, pinned where they are pure. The database halves
 * (loader, publication, tax, numbering under concurrency, suppression) are in
 * growth-owner-decisions.integration-postgres.spec.ts.
 */
const cfg = (values: Record<string, string | undefined>) => ({
  get: <T>(key: string) => values[key] as T | undefined,
});

describe('owner decisions 2026-10-27', () => {
  describe('prices (decision 5)', () => {
    const monthly = (plan: string, country: string) =>
      PROVISIONAL_MONTHLY_PRICES.find((p) => p.plan === plan && p.country === country);

    it('India Pro INR 999 and Premium INR 2,999 a month; USA Pro USD 19 and Premium USD 49', () => {
      expect(monthly('PRO', 'IN')).toMatchObject({ currency: 'INR', amountMinor: 99900 });
      expect(monthly('PREMIUM', 'IN')).toMatchObject({ currency: 'INR', amountMinor: 299900 });
      expect(monthly('PRO', 'US')).toMatchObject({ currency: 'USD', amountMinor: 1900 });
      expect(monthly('PREMIUM', 'US')).toMatchObject({ currency: 'USD', amountMinor: 4900 });
      expect(monthly('FREE', 'IN')?.amountMinor).toBe(0);
      expect(monthly('FREE', 'US')?.amountMinor).toBe(0);
    });

    it('an annual price is exactly ten times the monthly one', () => {
      expect(ANNUAL_PRICE_MULTIPLIER).toBe(10);
      expect(99900 * ANNUAL_PRICE_MULTIPLIER).toBe(999000);
      expect(299900 * ANNUAL_PRICE_MULTIPLIER).toBe(2999000);
      expect(1900 * ANNUAL_PRICE_MULTIPLIER).toBe(19000);
      expect(4900 * ANNUAL_PRICE_MULTIPLIER).toBe(49000);
    });
  });

  describe('Premium-only features (decision 10)', () => {
    const premiumOnly = [
      EntitlementKey.AUDIENCE_ADVANCED,
      EntitlementKey.CAMPAIGNS_AUTOMATION,
      EntitlementKey.CAMPAIGNS_ANALYTICS_ADVANCED,
    ];
    const on = (plan: 'FREE' | 'PRO' | 'PREMIUM', key: string) =>
      PROVISIONAL_PLAN_ENTITLEMENTS[plan].some((e) => e.key === key && e.boolValue === true);

    it('Premium has advanced segments, automation and advanced analytics', () => {
      for (const key of premiumOnly) expect(on('PREMIUM', key)).toBe(true);
    });

    it('Pro and Free have none of the three', () => {
      for (const key of premiumOnly) {
        expect(on('PRO', key)).toBe(false);
        expect(on('FREE', key)).toBe(false);
      }
    });
  });

  describe('email credit packs (decision 6)', () => {
    it('are 1,000, 5,000 and 10,000 credits', () => {
      expect(EMAIL_CREDIT_PACKS.map((p) => [p.code, p.credits])).toEqual([
        ['EMAIL_1K', 1000],
        ['EMAIL_5K', 5000],
        ['EMAIL_10K', 10000],
      ]);
    });

    it('carry no price in code, and only a PUBLISHED price puts one on sale', () => {
      expect(EMAIL_CREDIT_PACKS.every((p) => !('prices' in p))).toBe(true);
      expect(creditPackOffers([])).toEqual([]);
      const offers = creditPackOffers([
        { packCode: 'EMAIL_1K', currency: 'INR', amountMinor: 1, published: false },
        { packCode: 'EMAIL_5K', currency: 'INR', amountMinor: 2, published: true },
        { packCode: 'EMAIL_25K', currency: 'INR', amountMinor: 3, published: true },
      ]);
      expect(offers.map((o) => o.code)).toEqual(['EMAIL_5K']);
    });
  });

  describe('invoice series (decision 8)', () => {
    it('India: 31 March 23:59 IST is FY 2025-26, 1 April 00:00 IST is FY 2026-27', () => {
      // 23:59 IST on 31 March = 18:29 UTC; 00:00 IST on 1 April = 18:30 UTC on 31 March.
      const before = new Date('2026-03-31T18:29:59.999Z');
      const after = new Date('2026-03-31T18:30:00.000Z');
      expect(indianFinancialYearStart(before)).toBe(2025);
      expect(indianFinancialYearStart(after)).toBe(2026);
      expect(invoiceSeries('IN', before).scope).toBe('BIL-IN-FY2025-26');
      expect(invoiceSeries('IN', after).scope).toBe('BIL-IN-FY2026-27');
      expect(invoiceSeries('IN', before).format(1)).toBe('ETGB-2526-000001');
      expect(invoiceSeries('IN', after).format(1)).toBe('ETGB-2627-000001');
    });

    it('India numbers fit the 16 characters a GST invoice number may have', () => {
      const n = invoiceSeries('IN', new Date('2026-06-01T00:00:00Z')).format(999999);
      expect(n).toBe('ETGB-2627-999999');
      expect(n.length).toBeLessThanOrEqual(16);
      expect(n).toMatch(/^[A-Za-z0-9/-]+$/);
    });

    it('USA: one series per calendar year (UTC)', () => {
      const dec31 = new Date('2026-12-31T23:59:59.999Z');
      const jan1 = new Date('2027-01-01T00:00:00.000Z');
      expect(invoiceSeries('US', dec31).scope).toBe('BIL-US-2026');
      expect(invoiceSeries('US', jan1).scope).toBe('BIL-US-2027');
      expect(invoiceSeries('US', dec31).format(42)).toBe('ETG-BIL-US-2026-000042');
      expect(invoiceSeries('US', jan1).format(1)).toBe('ETG-BIL-US-2027-000001');
    });
  });

  describe('marketing email (decisions 1 to 4)', () => {
    it('a complaint is a MARKETING suppression; a hard bounce stops everything', () => {
      expect(scopeForReason('COMPLAINT')).toBe('MARKETING');
      expect(scopeForReason('HARD_BOUNCE')).toBe('ALL');
      expect(scopeForReason('UNSUBSCRIBED')).toBe('ALL');
      expect(scopeForReason('BLOCKED_BY_PROVIDER')).toBe('ALL');
    });

    it('the footer uses the address of the organizer country, never the other one', () => {
      const both = {
        MARKETING_POSTAL_ADDRESS_IN: 'IN address',
        MARKETING_POSTAL_ADDRESS_US: 'US address',
      };
      expect(campaignFooterAddress(cfg({ APP_ENV: 'PRODUCTION', ...both }), 'India').address).toBe(
        'IN address',
      );
      expect(campaignFooterAddress(cfg({ APP_ENV: 'PRODUCTION', ...both }), 'US').address).toBe(
        'US address',
      );
      // Any other country is the platform operator, DeepTrics LLC: the US address.
      expect(campaignFooterAddress(cfg({ APP_ENV: 'PRODUCTION', ...both }), 'CA').address).toBe(
        'US address',
      );
      const onlyUs = campaignFooterAddress(
        cfg({ APP_ENV: 'PRODUCTION', MARKETING_POSTAL_ADDRESS_US: 'US address' }),
        'IN',
      );
      expect(onlyUs.address).toBeNull();
      expect(onlyUs.refusal).toMatch(/MARKETING_POSTAL_ADDRESS_IN/);
    });

    it('the old single address is a fallback only', () => {
      const r = campaignFooterAddress(
        cfg({ APP_ENV: 'STAGING', MARKETING_POSTAL_ADDRESS: 'Old address' }),
        'IN',
      );
      expect(r).toMatchObject({ address: 'Old address', source: 'LEGACY', refusal: null });
    });

    it('STAGING and PRODUCTION refuse without an address; QA prints a labelled placeholder', () => {
      for (const env of ['STAGING', 'PRODUCTION']) {
        expect(campaignFooterAddress(cfg({ APP_ENV: env }), 'US').refusal).toBeTruthy();
      }
      for (const env of ['LOCAL', 'DEV', 'QA', 'UAT']) {
        const r = campaignFooterAddress(cfg({ APP_ENV: env }), 'IN');
        expect(r.refusal).toBeNull();
        expect(r.address).toBe(POSTAL_ADDRESS_PLACEHOLDER);
        expect(r.address).toBe('Postal address pending verification (QA)');
      }
    });

    it('STAGING and PRODUCTION refuse campaigns without UNSUBSCRIBE_SIGNING_SECRET', () => {
      const live = {
        CAMPAIGNS_ENABLED: 'true',
        EMAIL_PROVIDER: 'ses',
        MARKETING_EMAIL_FROM: 'updates@eticketsgo.com',
        SES_MARKETING_CONFIGURATION_SET: 'marketing',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
      };
      for (const env of ['STAGING', 'PRODUCTION']) {
        expect(campaignSendingConfig(cfg({ ...live, APP_ENV: env })).refusal).toMatch(
          /UNSUBSCRIBE_SIGNING_SECRET/,
        );
        expect(() => unsubscribeKey(cfg({ ...live, APP_ENV: env }))).toThrow(
          /UNSUBSCRIBE_SIGNING_SECRET/,
        );
        expect(
          campaignSendingConfig(
            cfg({ ...live, APP_ENV: env, UNSUBSCRIBE_SIGNING_SECRET: 's'.repeat(40) }),
          ).refusal,
        ).toBeNull();
      }
      // Elsewhere the derived key still works, as before.
      expect(() => unsubscribeKey(cfg({ ...live, APP_ENV: 'QA' }))).not.toThrow();
    });
  });

  describe('everything paid or promotional stays off until switched on (decision 12)', () => {
    const ORIGINAL = process.env;
    afterEach(() => {
      process.env = ORIGINAL;
    });

    it('BILLING_ENABLED and CAMPAIGNS_ENABLED default to false', () => {
      process.env = {
        ...ORIGINAL,
        APP_ENV: 'LOCAL',
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://u:p@db/x',
        JWT_ACCESS_SECRET: 'a'.repeat(40),
        JWT_REFRESH_SECRET: 'b'.repeat(40),
        QR_SIGNING_SECRET: 'c'.repeat(40),
        PAYMENT_WEBHOOK_SECRET: 'd'.repeat(40),
      };
      delete process.env.BILLING_ENABLED;
      delete process.env.CAMPAIGNS_ENABLED;
      delete process.env.BILLING_PROVIDER;
      delete process.env.STRIPE_BILLING_AUTOMATIC_TAX;
      const c = loadConfig();
      expect(c.BILLING_ENABLED).toBe('false');
      expect(c.CAMPAIGNS_ENABLED).toBe('false');
      expect(c.BILLING_PROVIDER).toBe('disabled');
      expect(c.STRIPE_BILLING_AUTOMATIC_TAX).toBe('false');
    });

    it('with nothing set, a campaign is refused everywhere', () => {
      for (const env of ['LOCAL', 'QA', 'STAGING', 'PRODUCTION']) {
        expect(campaignSendingConfig(cfg({ APP_ENV: env })).refusal).toMatch(/not switched on/);
      }
    });
  });
});
