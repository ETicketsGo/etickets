import { ConfigService } from '@nestjs/config';
import { ManualTaxProvider } from './providers/manual-tax.provider';
import {
  ExternalTaxProvider,
  fromVendorResponse,
  toVendorRequest,
} from './providers/external-tax.provider';
import { selectTaxProvider } from './tax.module';
import type { TaxQuoteRequest } from './tax-provider.interface';

/**
 * The tax seam.
 *
 * The behaviour worth pinning is not the arithmetic — that belongs to whoever answers the
 * question — but what happens when the answer cannot be obtained. Every path that could
 * quietly resolve to "no tax" is a path that under-collects on real orders and leaves the
 * platform, not the customer, holding the difference.
 */

const cfg = (values: Record<string, string> = {}) =>
  ({ get: (k: string) => values[k] }) as unknown as ConfigService;

const request = (over: Partial<TaxQuoteRequest> = {}): TaxQuoteRequest => ({
  context: { currency: 'USD', country: 'United States', region: 'CA', at: new Date('2026-08-01') },
  netSubtotalMinor: 100_000,
  customerFeeMinor: 4_040,
  lines: [{ reference: 'tickets', kind: 'admission', amountMinor: 100_000 }],
  ...over,
});

describe('selectTaxProvider', () => {
  const prisma = { taxRule: { findMany: jest.fn().mockResolvedValue([]) } } as never;

  it('defaults to the manual TaxRule table', () => {
    expect(selectTaxProvider(cfg(), prisma).name).toBe('manual');
  });

  it('refuses an unknown provider rather than defaulting to one', () => {
    // A typo in TAX_PROVIDER must not silently fall back to charging nothing. That is
    // under-collection arriving through a configuration mistake.
    expect(() => selectTaxProvider(cfg({ TAX_PROVIDER: 'avalra' }), prisma)).toThrow(
      /Unknown TAX_PROVIDER/,
    );
  });

  it('fails at boot when external is selected without credentials', () => {
    // Not at the first checkout. A missing key should stop a deploy, not a customer.
    expect(() => selectTaxProvider(cfg({ TAX_PROVIDER: 'external' }), prisma)).toThrow(
      /TAX_EXTERNAL_ENDPOINT/,
    );
  });

  it('constructs the external provider when fully configured', () => {
    const provider = selectTaxProvider(
      cfg({
        TAX_PROVIDER: 'external',
        TAX_EXTERNAL_ENDPOINT: 'https://tax.example.test/quote',
        TAX_EXTERNAL_API_KEY: 'k',
        TAX_EXTERNAL_VENDOR: 'stripe-tax',
      }),
      prisma,
    );
    expect(provider.name).toBe('stripe-tax');
  });
});

describe('ManualTaxProvider', () => {
  it('charges nothing when no rule is active, which is the shipped default', async () => {
    const prisma = { taxRule: { findMany: jest.fn().mockResolvedValue([]) } } as never;
    const result = await new ManualTaxProvider(prisma).quote(request());
    expect(result).toEqual({ taxLines: [], taxMinor: 0, provider: 'manual', providerRef: null });
  });

  it('queries only the sale currency and the wildcard', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await new ManualTaxProvider({ taxRule: { findMany } } as never).quote(request());
    expect(findMany.mock.calls[0][0].where).toEqual({
      active: true,
      currency: { in: ['USD', '*'] },
    });
  });

  it('applies an active rule to the amount the customer is charged', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        label: 'Fixture tax',
        rateBasisPoints: 1000, // 10% — a fixture, not a claim about any jurisdiction
        appliesTo: 'TICKETS_AND_FEES',
        country: '*',
        region: '*',
        currency: 'USD',
        priority: 100,
        active: true,
        effectiveFrom: null,
        effectiveTo: null,
      },
    ]);
    const result = await new ManualTaxProvider({ taxRule: { findMany } } as never).quote(request());
    expect(result.taxMinor).toBe(10_404);
    expect(result.provider).toBe('manual');
  });
});

describe('ExternalTaxProvider wire contract', () => {
  it('presents the customer-borne fee as its own line', () => {
    // Several jurisdictions tax a booking fee differently from the admission it sits on,
    // so the fee has to be visible to the vendor rather than folded into the ticket.
    const body = toVendorRequest(request());
    expect(body.lines.map((l) => l.reference)).toEqual(['tickets', 'booking-fee']);
    expect(body.lines[1].amountMinor).toBe(4_040);
  });

  it('omits the fee line when the organizer absorbs the fee', () => {
    const body = toVendorRequest(request({ customerFeeMinor: 0 }));
    expect(body.lines.map((l) => l.reference)).toEqual(['tickets']);
  });

  it('sends the place of supply, not the seller address', () => {
    const body = toVendorRequest(request());
    expect(body.destination).toEqual({
      country: 'United States',
      region: 'CA',
      postalCode: null,
    });
  });

  it('parses a well-formed response and sums it', () => {
    const result = fromVendorResponse('stripe-tax', {
      reference: 'calc_123',
      lines: [
        { label: 'CA state', rateBasisPoints: 725, baseMinor: 100_000, amountMinor: 7_250 },
        { label: 'LA county', rateBasisPoints: 225, baseMinor: 100_000, amountMinor: 2_250 },
      ],
    });
    expect(result.taxMinor).toBe(9_500);
    expect(result.providerRef).toBe('calc_123');
    expect(result.taxLines).toHaveLength(2);
  });

  it('refuses a response it cannot fully understand', () => {
    // Reading an unparseable body as "no tax" is the same under-collection the fail-closed
    // rule exists to prevent, arriving through a different door.
    expect(() => fromVendorResponse('x', {})).toThrow(/no line array/);
    expect(() => fromVendorResponse('x', { lines: [{ label: 'GST' }] })).toThrow(/malformed/);
    expect(() =>
      fromVendorResponse('x', {
        lines: [{ label: 'GST', rateBasisPoints: 5.5, baseMinor: 1, amountMinor: 1 }],
      }),
    ).toThrow(/malformed/);
  });
});

describe('ExternalTaxProvider failure behaviour', () => {
  const base = {
    TAX_EXTERNAL_ENDPOINT: 'https://tax.example.test/quote',
    TAX_EXTERNAL_API_KEY: 'k',
    TAX_EXTERNAL_TIMEOUT_MS: '50',
  };
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('refuses the sale when the tax service is unreachable', async () => {
    // Charging no tax during an outage under-collects on every order for its duration, and
    // the platform is liable for the difference. A refused checkout is visible and bounded.
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    const provider = new ExternalTaxProvider(cfg(base));
    await expect(provider.quote(request())).rejects.toThrow(/could not calculate tax/i);
  });

  it('refuses on a non-2xx response too', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as never;
    const provider = new ExternalTaxProvider(cfg(base));
    await expect(provider.quote(request())).rejects.toThrow(/could not calculate tax/i);
  });

  it('proceeds with zero tax ONLY when fail-open is explicitly switched on', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as never;
    const provider = new ExternalTaxProvider(cfg({ ...base, TAX_EXTERNAL_FAIL_OPEN: 'true' }));
    const result = await provider.quote(request());
    expect(result.taxMinor).toBe(0);
    expect(result.taxLines).toEqual([]);
  });

  it('returns the vendor answer on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reference: 'calc_9',
        lines: [{ label: 'State', rateBasisPoints: 600, baseMinor: 104_040, amountMinor: 6_242 }],
      }),
    }) as never;
    const provider = new ExternalTaxProvider(cfg({ ...base, TAX_EXTERNAL_VENDOR: 'taxjar' }));
    const result = await provider.quote(request());
    expect(result.taxMinor).toBe(6_242);
    expect(result.provider).toBe('taxjar');
  });
});
