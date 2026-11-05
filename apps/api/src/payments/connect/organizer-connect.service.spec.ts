import { OrganizerConnectService } from './organizer-connect.service';
import { AppException } from '../../common/errors';

function makeService(opts: {
  account?: Record<string, unknown> | null;
  org?: Record<string, unknown> | null;
}) {
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
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.org === undefined
            ? { id: 'org1', contactEmail: 'o@x.io', registeredCountry: 'US' }
            : opts.org,
        ),
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
  return { service, prisma, access, provider, resolver, created, user };
}

/** What a call threw, as the envelope the organizer's browser receives. */
async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppException);
    const e = err as AppException;
    return { status: e.getStatus(), code: e.code, message: e.message, details: e.details };
  }
  throw new Error('expected a refusal');
}

/** A Stripe SDK error, shaped as the SDK throws it (a `type` naming the class). */
function stripeError(type: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { type, ...extra });
}

const ACCOUNTS_V1 =
  'Stripe no longer recommends Accounts v1 for new Connect integrations. Create connected accounts with POST /v2/core/accounts instead. enable Accounts v1 support in the Dashboard';

describe('OrganizerConnectService.createOrGetAccount', () => {
  it('says the provider is not set up here when Stripe refuses the platform request', async () => {
    /*
      QA, 2026-10-28: POST /organizers/:id/payments/stripe/onboarding-link -> 502 with Stripe's
      own sentence ("Stripe no longer recommends Accounts v1 ... enable Accounts v1 support in
      the Dashboard") printed to the organizer. That is OUR platform account's setting, not
      anything the organizer can do, and an earlier build printed "Something went wrong." for
      it. The organizer now gets a code and plain words; Stripe's sentence goes to the log.
    */
    const { service, provider, user } = makeService({ account: null });
    provider.createConnectedAccount.mockRejectedValue(
      stripeError('StripeInvalidRequestError', ACCOUNTS_V1, { statusCode: 400 }),
    );

    const r = await refusal(service.createOrGetAccount(user, 'org1', { country: 'US' } as never));
    expect(r.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    expect(r.status).toBe(503);
    expect(r.message).not.toMatch(/Accounts v1|Stripe|Dashboard/);
  });

  it('says try again when Stripe cannot be reached', async () => {
    const { service, provider, user } = makeService({ account: null });
    provider.createConnectedAccount.mockRejectedValue(
      stripeError('StripeConnectionError', 'An error occurred with our connection to Stripe.'),
    );
    const r = await refusal(service.createOrGetAccount(user, 'org1', { country: 'US' } as never));
    expect(r.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(r.status).toBe(503);
    expect(r.details).toMatchObject({ retryable: true });
  });

  it('names the organization detail Stripe rejected', async () => {
    const { service, provider, user } = makeService({ account: null });
    provider.createConnectedAccount.mockRejectedValue(
      stripeError('StripeInvalidRequestError', 'Invalid email address: o@x', { param: 'email' }),
    );
    const r = await refusal(service.createOrGetAccount(user, 'org1', { country: 'US' } as never));
    expect(r.code).toBe('ORGANIZATION_DETAILS_INCOMPLETE');
    expect(r.details).toMatchObject({ fields: ['contactEmail'] });
  });

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

describe('OrganizerConnectService.createOrGetAccount - country gate', () => {
  /*
    QA certification of main 60eee811: POST stripe/account took the caller's `country`
    (default US) straight to Stripe, without the gate the onboarding link applies.
  */
  it('refuses an Indian organization before asking Stripe anything', async () => {
    const { service, provider, user } = makeService({
      account: null,
      org: { id: 'org1', contactEmail: 'o@x.io', registeredCountry: 'IN' },
    });
    const r = await refusal(service.createOrGetAccount(user, 'org1', { country: 'US' }));
    expect(r.status).toBe(422);
    expect(r.code).toBe('PAYOUT_COUNTRY_UNSUPPORTED');
    expect(r.details).toMatchObject({ country: 'IN' });
    expect(provider.createConnectedAccount).not.toHaveBeenCalled();
  });

  it('asks for the country of registration when it is missing, before asking Stripe', async () => {
    const { service, provider, user } = makeService({
      account: null,
      org: { id: 'org1', contactEmail: 'o@x.io', registeredCountry: null },
    });
    const r = await refusal(service.createOrGetAccount(user, 'org1', {}));
    expect(r.status).toBe(422);
    expect(r.code).toBe('ORGANIZATION_DETAILS_INCOMPLETE');
    expect(r.details).toMatchObject({ fields: ['registeredCountry'] });
    expect(provider.createConnectedAccount).not.toHaveBeenCalled();
  });

  it('refuses a country that is not the country of registration, before asking Stripe', async () => {
    const { service, provider, user } = makeService({
      account: null,
      org: { id: 'org1', contactEmail: 'o@x.io', registeredCountry: 'Canada' },
    });
    const r = await refusal(service.createOrGetAccount(user, 'org1', { country: 'US' }));
    expect(r.status).toBe(422);
    expect(r.code).toBe('VALIDATION_FAILED');
    expect(r.details).toMatchObject({ fields: ['country'], registeredCountry: 'CA' });
    expect(provider.createConnectedAccount).not.toHaveBeenCalled();
  });

  it('opens the account in the country of registration when the caller sends none', async () => {
    const { service, provider, created, user } = makeService({
      account: null,
      org: { id: 'org1', contactEmail: 'o@x.io', registeredCountry: 'Canada' },
    });
    await service.createOrGetAccount(user, 'org1', {});
    expect(provider.createConnectedAccount).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'CA' }),
    );
    expect(created[0]).toMatchObject({ country: 'CA' });
  });
});

describe('OrganizerConnectService.createOnboardingLink', () => {
  /** The read after creation finds the row the upsert wrote. */
  function withStoredAccount(prisma: { organizerPaymentAccount: Record<string, unknown> }) {
    prisma.organizerPaymentAccount.findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ id: 'row1', providerAccountId: 'acct_1' });
  }

  it('opens the account in the country the organization is registered in, not always US', async () => {
    // Was hardcoded `{ country: 'US' }`: a Toronto organizer got a United States account.
    const { service, prisma, provider, user } = makeService({
      account: null,
      org: { id: 'org1', contactEmail: 'o@x.io', registeredCountry: 'Canada' },
    });
    withStoredAccount(prisma);
    await service.createOnboardingLink(user, 'org1');
    expect(provider.createConnectedAccount).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'CA' }),
    );
  });

  it('refuses a country Stripe does not pay out to before asking Stripe anything', async () => {
    // An Indian organizer selling in dollars sees the card panel; Stripe cannot pay them.
    const { service, provider, user } = makeService({
      account: null,
      org: { id: 'org1', contactEmail: 'o@x.io', registeredCountry: 'India' },
    });
    const r = await refusal(service.createOnboardingLink(user, 'org1'));
    expect(r.code).toBe('PAYOUT_COUNTRY_UNSUPPORTED');
    expect(r.status).toBe(422);
    expect(r.details).toMatchObject({ country: 'IN' });
    expect(provider.createConnectedAccount).not.toHaveBeenCalled();
  });

  it('asks for the country of registration when it is missing', async () => {
    const { service, provider, user } = makeService({
      account: null,
      org: { id: 'org1', contactEmail: 'o@x.io', registeredCountry: null },
    });
    const r = await refusal(service.createOnboardingLink(user, 'org1'));
    expect(r.code).toBe('ORGANIZATION_DETAILS_INCOMPLETE');
    expect(r.details).toMatchObject({ fields: ['registeredCountry'] });
    expect(provider.createConnectedAccount).not.toHaveBeenCalled();
  });

  it('says the provider is not set up when this server has no Stripe keys (was a bare 500)', async () => {
    const { service, resolver, user } = makeService({ account: null });
    resolver.get.mockImplementation(() => {
      throw new Error('PAYMENT_PROVIDER_NAME=stripe requires STRIPE_SECRET_KEY to be set.');
    });
    const r = await refusal(service.createOnboardingLink(user, 'org1'));
    expect(r.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    expect(r.message).not.toMatch(/STRIPE_SECRET_KEY/);
  });

  it('says the provider is not set up when payments are not activated here', async () => {
    const { service, resolver, user } = makeService({ account: null });
    resolver.get.mockReturnValue({ name: 'stripe' });
    const r = await refusal(service.createOnboardingLink(user, 'org1'));
    expect(r.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
  });

  it('classifies a failed hosted-link request instead of letting it become a 500', async () => {
    const { service, prisma, provider, user } = makeService({
      account: {
        id: 'row1',
        organizationId: 'org1',
        provider: 'stripe',
        providerAccountId: 'acct_1',
      },
    });
    withStoredAccount(prisma);
    provider.createOnboardingLink.mockRejectedValue(
      stripeError('StripeAPIError', 'Something went wrong on our end'),
    );
    const r = await refusal(service.createOnboardingLink(user, 'org1'));
    expect(r.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });

  it('passes the owner-only refusal through unchanged', async () => {
    const { service, access, user } = makeService({ account: null });
    access.assertMember.mockRejectedValue(
      new AppException(
        'TENANT_FORBIDDEN',
        'Your organization role does not permit this action.',
        403,
      ),
    );
    const r = await refusal(service.createOnboardingLink(user, 'org1'));
    expect(r.code).toBe('TENANT_FORBIDDEN');
    expect(r.status).toBe(403);
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
