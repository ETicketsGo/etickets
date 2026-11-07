import { EventSellabilityService } from '../events/event-sellability.service';
import { gatedProviderFor, organizerPaymentsGap, stripeConfiguredIn } from './organizer-payment-readiness';

/**
 * Pilot walk 2026-11-07: every US paid event on QA was listed and reservable, and only the
 * payment page said the organizer "cannot take card payments yet". These pin the earlier
 * answer to the same rule the payment step applies, and nothing stricter.
 */
const account = (row: { providerAccountId: string | null; chargesEnabled: boolean } | null) => {
  const calls: unknown[] = [];
  return {
    calls,
    organizerPaymentAccount: {
      findUnique: async (args: unknown) => {
        calls.push(args);
        return row;
      },
    },
  };
};

describe('organizerPaymentsGap', () => {
  it('never gates India: INR goes to Razorpay, which needs no organizer account', async () => {
    const db = account(null);
    expect(await organizerPaymentsGap(db, true, 'org1', 'INR')).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  it('gates USD when Stripe is configured and the organizer has no connected account', async () => {
    expect(await organizerPaymentsGap(account(null), true, 'org1', 'USD')).toBe('stripe');
  });

  it('gates USD while the connected account cannot take charges yet', async () => {
    const db = account({ providerAccountId: 'acct_1', chargesEnabled: false });
    expect(await organizerPaymentsGap(db, true, 'org1', 'USD')).toBe('stripe');
  });

  it('lets USD sell once the connected account takes charges', async () => {
    const db = account({ providerAccountId: 'acct_1', chargesEnabled: true });
    expect(await organizerPaymentsGap(db, true, 'org1', 'USD')).toBeNull();
    expect(db.calls[0]).toMatchObject({
      where: { organizationId_provider: { organizationId: 'org1', provider: 'stripe' } },
    });
  });

  it('does not gate where Stripe is not configured (local, CI, mock): payment has no such refusal there', async () => {
    expect(await organizerPaymentsGap(account(null), false, 'org1', 'USD')).toBeNull();
    expect(gatedProviderFor('USD', false)).toBeNull();
  });

  it('treats Stripe as configured only with both keys, as its adapter does', () => {
    const env = (vars: Record<string, string>) => (k: string) => vars[k];
    expect(stripeConfiguredIn(env({ STRIPE_SECRET_KEY: 'x' }))).toBe(false);
    expect(stripeConfiguredIn(env({ STRIPE_SECRET_KEY: 'x', STRIPE_WEBHOOK_SECRET: 'y' }))).toBe(
      true,
    );
  });
});

describe('EventSellabilityService: PAYMENTS_NOT_READY', () => {
  const config = (on: boolean) =>
    ({
      get: (k: string) =>
        on && (k === 'STRIPE_SECRET_KEY' || k === 'STRIPE_WEBHOOK_SECRET') ? 'set' : undefined,
    }) as never;

  const usEvent = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    isFree: false,
    organizationId: 'org1',
    venue: { country: 'US', region: 'ID', timezone: 'America/Boise' },
    organization: { registeredCountry: 'US', registeredRegion: 'ID' },
    sessions: [
      {
        id: 's1',
        startsAt: new Date('2026-12-01T02:00:00.000Z'),
        seatMapId: null,
        screenId: null,
        screen: null,
        ticketTypes: [
          { id: 't1', name: 'General', priceMinor: 2500, currency: 'USD', seatCategory: null },
        ],
        _count: { showSeats: 0 },
      },
    ],
    ...over,
  });

  const prisma = (event: unknown, acct: unknown) =>
    ({
      event: { findUnique: async () => event },
      taxRule: { findMany: async () => [] },
      organizerPaymentAccount: { findUnique: async () => acct },
    }) as never;

  it('blocks publishing a US paid event until Stripe can take charges, and points to Payouts', async () => {
    const svc = new EventSellabilityService(prisma(usEvent(), null), undefined, config(true));
    const report = await svc.check('e1');
    expect(report.sellable).toBe(false);
    const b = report.blockers.find((x) => x.code === 'PAYMENTS_NOT_READY');
    expect(b).toMatchObject({ owner: 'ORGANIZER', fixPath: '/organizer/payouts' });
  });

  it('clears once the connected account takes charges', async () => {
    const svc = new EventSellabilityService(
      prisma(usEvent(), { providerAccountId: 'acct_1', chargesEnabled: true }),
      undefined,
      config(true),
    );
    const report = await svc.check('e1');
    expect(report.blockers.map((b) => b.code)).not.toContain('PAYMENTS_NOT_READY');
  });

  it('never blocks a free event', async () => {
    const free = usEvent({
      isFree: true,
      sessions: [{ ...usEvent().sessions[0], ticketTypes: [{ ...usEvent().sessions[0].ticketTypes[0], priceMinor: 0 }] }],
    });
    const svc = new EventSellabilityService(prisma(free, null), undefined, config(true));
    expect((await svc.check('e1')).blockers.map((b) => b.code)).not.toContain('PAYMENTS_NOT_READY');
  });
});
