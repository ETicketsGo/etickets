import { PaymentsService } from './payments.service';
import { AddOnInventoryService } from '../commerce/addon-inventory.service';
import { MetricsService } from '../metrics/metrics.service';
import { BookingReferenceService } from '../bookings/booking-reference.service';

/**
 * Whether a booking can be paid for, asked before Pay is pressed (PROD, 2026-11-05).
 *
 * The checkout used to learn that payments were unavailable only from a refused Pay, then
 * showed "Online payment is being activated" beside a Pay button that stayed enabled. These
 * pin the three answers the page now reads up front, each from the same gate Pay applies.
 */
type Shape = {
  status?: string;
  totalMinor?: number;
  currency?: string;
  country?: string;
};

function setup(
  booking: Shape | null,
  opts: {
    account?: { providerAccountId: string | null; chargesEnabled: boolean } | null;
    stripeAdapter?: boolean;
    routed?: boolean;
    razorpayKey?: boolean;
  } = {},
) {
  const row = booking && {
    status: booking.status ?? 'PENDING_PAYMENT',
    totalMinor: booking.totalMinor ?? 1121,
    currency: booking.currency ?? 'USD',
    paymentMethod: 'ONLINE',
    event: { organizationId: 'org-1', venue: { country: booking.country ?? 'United States' } },
  };
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(row) },
    organizerPaymentAccount: { findUnique: jest.fn().mockResolvedValue(opts.account ?? null) },
  };
  // A Connect-capable adapter exists only where Stripe is configured.
  const stripe = { name: 'stripe', createTransfer: jest.fn() };
  const resolver = {
    get: jest.fn((name: string) => {
      if (name === 'stripe' && opts.stripeAdapter) return stripe;
      throw new Error('not configured');
    }),
  };
  const orchestrator = {
    providerAvailable: jest
      .fn()
      .mockResolvedValue(
        opts.routed ? { available: true, provider: 'stripe' } : { available: false },
      ),
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'RAZORPAY_KEY_ID' && opts.razorpayKey ? 'rzp_test_x' : undefined,
    ),
  };
  const service = new PaymentsService(
    prisma as never,
    {} as never,
    {} as never,
    orchestrator as never,
    resolver as never,
    { record: jest.fn() } as never,
    {} as never,
    {} as never,
    new AddOnInventoryService(),
    new MetricsService(),
    new BookingReferenceService(),
    {} as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, orchestrator, prisma };
}

describe('can this booking be paid for, before Pay is pressed', () => {
  it('the platform has no gateway for USD (PROD today): platform_not_configured', async () => {
    const { service } = setup({ currency: 'USD' }, { routed: false });
    await expect(service.paymentAvailability('b1')).resolves.toEqual({
      available: false,
      reason: 'platform_not_configured',
    });
  });

  it('Stripe is configured but the organizer has not finished Connect: organizer_not_onboarded', async () => {
    const { service, orchestrator } = setup(
      { currency: 'USD' },
      { stripeAdapter: true, routed: true, account: null },
    );
    await expect(service.paymentAvailability('b1')).resolves.toEqual({
      available: false,
      reason: 'organizer_not_onboarded',
    });
    expect(orchestrator.providerAvailable).not.toHaveBeenCalled();
  });

  it('an account that exists but cannot take charges yet is not onboarded either', async () => {
    const { service } = setup(
      { currency: 'USD' },
      {
        stripeAdapter: true,
        routed: true,
        account: { providerAccountId: 'acct_1', chargesEnabled: false },
      },
    );
    await expect(service.paymentAvailability('b1')).resolves.toMatchObject({
      reason: 'organizer_not_onboarded',
    });
  });

  it('everything in place: available, naming the gateway', async () => {
    const { service } = setup(
      { currency: 'USD' },
      {
        stripeAdapter: true,
        routed: true,
        account: { providerAccountId: 'acct_1', chargesEnabled: true },
      },
    );
    await expect(service.paymentAvailability('b1')).resolves.toEqual({
      available: true,
      provider: 'stripe',
    });
  });

  it('INR with Razorpay configured is available, as Pay would route it', async () => {
    const { service } = setup({ currency: 'INR', country: 'India' }, { razorpayKey: true });
    await expect(service.paymentAvailability('b1')).resolves.toEqual({
      available: true,
      provider: 'razorpay',
    });
  });

  it.each([
    ['a paid booking', { status: 'CONFIRMED' }],
    ['a free booking', { totalMinor: 0 }],
    ['an expired hold', { status: 'EXPIRED' }],
  ])('%s is not payable and says so without asking any gateway', async (_, shape) => {
    const { service, orchestrator } = setup(shape, { routed: true });
    await expect(service.paymentAvailability('b1')).resolves.toEqual({
      available: false,
      reason: 'not_payable',
    });
    expect(orchestrator.providerAvailable).not.toHaveBeenCalled();
  });

  it('an unknown booking id reveals nothing beyond not_payable', async () => {
    const { service } = setup(null);
    await expect(service.paymentAvailability('nope')).resolves.toEqual({
      available: false,
      reason: 'not_payable',
    });
  });
});
