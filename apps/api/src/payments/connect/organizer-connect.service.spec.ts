import { OrganizerConnectService } from './organizer-connect.service';

function makeService(opts: { account?: Record<string, unknown> | null }) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    organizerPaymentAccount: {
      findUnique: jest.fn().mockResolvedValue(opts.account ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.account ?? null),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        const row = { id: 'row1', ...create };
        created.push(row);
        return row;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'row1',
        organizationId: 'org1',
        provider: 'stripe',
        providerAccountId: 'acct_1',
        accountType: 'express',
        country: 'US',
        defaultCurrency: 'usd',
        onboardingStatus: 'ENABLED',
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsDue: [],
        disabledReason: null,
        ...data,
      })),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ id: 'org1', contactEmail: 'o@x.io' }),
    },
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: jest.fn().mockReturnValue('express'),
    getOrThrow: jest.fn().mockReturnValue('http://return'),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const provider = {
    name: 'stripe',
    createConnectedAccount: jest.fn().mockResolvedValue({ accountId: 'acct_new' }),
    getConnectedAccount: jest.fn().mockResolvedValue({
      accountId: 'acct_1',
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsCurrentlyDue: [],
      disabledReason: null,
    }),
    createOnboardingLink: jest.fn().mockResolvedValue({ url: 'https://connect.stripe.com/x' }),
    createDashboardLink: jest.fn().mockResolvedValue({ url: 'https://dash' }),
  };
  /*
    A RESOLVER, not a provider. This service used to take whichever provider was globally
    configured — which is `mock` — so with Stripe fully set up it answered "the active
    payment provider (mock) does not support connected accounts". It resolves `stripe` by
    name now, and the stub asserts that is what it asks for.
  */
  const resolver = { get: jest.fn().mockReturnValue(provider) };
  const service = new OrganizerConnectService(
    prisma as never,
    access as never,
    config as never,
    audit as never,
    resolver as never,
  );
  const user = { id: 'u1', email: 'u@x.io', fullName: 'U', roles: ['ORGANIZER_OWNER'] } as never;
  return { service, prisma, provider, resolver, created, user };
}

describe('OrganizerConnectService.createOrGetAccount', () => {
  it('asks the resolver for stripe by name, not for whatever is globally configured', async () => {
    // The defect this replaced: `/organizers/:id/payments/stripe/account` answered
    // `501 The active payment provider (mock) does not support connected accounts` on an
    // environment where Stripe was correctly configured — naming a provider nobody asked for.
    const { service, resolver, user } = makeService({ account: null });
    await service.createOrGetAccount(user, 'org1', { country: 'US' } as never);
    expect(resolver.get).toHaveBeenCalledWith('stripe');
  });

  it('returns the existing account without creating a duplicate', async () => {
    const { service, provider } = makeService({
      account: {
        organizationId: 'org1',
        provider: 'stripe',
        providerAccountId: 'acct_1',
        accountType: 'express',
        onboardingStatus: 'ONBOARDING',
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirementsDue: [],
        disabledReason: null,
        country: 'US',
        defaultCurrency: 'usd',
      },
    });
    const status = await service.createOrGetAccount(
      { id: 'u1', roles: ['ORGANIZER_OWNER'] } as never,
      'org1',
      {
        country: 'US',
      },
    );
    expect(provider.createConnectedAccount).not.toHaveBeenCalled();
    expect(status.hasAccount).toBe(true);
  });

  it('creates + persists a connected account when none exists', async () => {
    const { service, provider, created, user } = makeService({ account: null });
    await service.createOrGetAccount(user, 'org1', { country: 'US' });
    expect(provider.createConnectedAccount).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org1', country: 'US' }),
    );
    expect(created[0]).toMatchObject({
      providerAccountId: 'acct_new',
      onboardingStatus: 'ONBOARDING',
    });
  });
});

describe('OrganizerConnectService.getStatus', () => {
  it('refreshes capability flags live from the provider', async () => {
    const { service, provider, user } = makeService({
      account: {
        id: 'row1',
        organizationId: 'org1',
        provider: 'stripe',
        providerAccountId: 'acct_1',
      },
    });
    const status = await service.getStatus(user, 'org1');
    expect(provider.getConnectedAccount).toHaveBeenCalledWith('acct_1');
    expect(status.chargesEnabled).toBe(true);
    expect(status.onboardingStatus).toBe('ENABLED');
  });

  it('returns NOT_STARTED when there is no account', async () => {
    const { service, user } = makeService({ account: null });
    const status = await service.getStatus(user, 'org1');
    expect(status.hasAccount).toBe(false);
    expect(status.onboardingStatus).toBe('NOT_STARTED');
  });
});
