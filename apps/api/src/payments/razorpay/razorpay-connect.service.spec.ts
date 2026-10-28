import { RazorpayConnectService } from './razorpay-connect.service';
import { AppException } from '../../common/errors';

/*
  QA certification of main 60eee811: POST /organizers/:id/payments/razorpay/account answered
  500 "Something went wrong." for every Razorpay refusal - a mistyped acc_ id included -
  because the SDK rejection was not caught. And a US organization, or one with no country,
  reached Razorpay at all. These pin the classified answers, all against a mock provider.
*/

function makeService(opts: { org?: Record<string, unknown> | null } = {}) {
  const prisma = {
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.org === undefined ? { id: 'org1', registeredCountry: 'India' } : opts.org,
        ),
    },
    organizerPaymentAccount: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: 'row1',
        ...create,
      })),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const provider = {
    name: 'razorpay',
    getConnectedAccount: jest.fn().mockResolvedValue({
      accountId: 'acc_ABCDEFGHIJKLMN',
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsCurrentlyDue: [],
      disabledReason: null,
    }),
  };
  const resolver = { get: jest.fn().mockReturnValue(provider) };
  const config = { get: jest.fn().mockReturnValue(false) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new RazorpayConnectService(
    prisma as never,
    access as never,
    resolver as never,
    config as never,
    audit as never,
  );
  const user = { id: 'u1', roles: ['ORGANIZER_OWNER'] } as never;
  return { service, prisma, provider, resolver, user };
}

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

/** A Razorpay SDK rejection, shaped as the SDK throws it (a plain object, not an Error). */
function razorpayRejection(statusCode: number, description: string, code = 'BAD_REQUEST_ERROR') {
  return { statusCode, error: { code, description } };
}

describe('RazorpayConnectService.linkAccount - Razorpay refusals', () => {
  it('says the linked account was not found (422) instead of a 500', async () => {
    const { service, provider, user } = makeService();
    provider.getConnectedAccount.mockRejectedValue(
      razorpayRejection(400, 'The id provided does not exist'),
    );
    const r = await refusal(service.linkAccount(user, 'org1', 'acc_DOESNOTEXIST01'));
    expect(r.status).toBe(422);
    expect(r.code).toBe('PAYOUT_ACCOUNT_NOT_FOUND');
    expect(r.message).toBe(
      'We could not find that Razorpay linked account. Check the account ID (acc_...) and try again.',
    );
    expect(r.message).not.toMatch(/does not exist/);
  });

  it('says try again (503, retryable) when Razorpay fails or cannot be reached', async () => {
    for (const err of [
      razorpayRejection(500, 'We are facing some trouble', 'SERVER_ERROR'),
      razorpayRejection(429, 'Too many requests'),
      new TypeError("Cannot read properties of undefined (reading 'status')"),
    ]) {
      const { service, provider, user } = makeService();
      provider.getConnectedAccount.mockRejectedValue(err);
      const r = await refusal(service.linkAccount(user, 'org1', 'acc_ABCDEFGHIJKLMN'));
      expect(r.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      expect(r.status).toBe(503);
      expect(r.details).toMatchObject({ retryable: true });
      expect(r.message).not.toMatch(/trouble|Too many|Cannot read/);
    }
  });

  it('says payout setup is not switched on (503) when our credentials are refused', async () => {
    const { service, provider, user } = makeService();
    provider.getConnectedAccount.mockRejectedValue(
      razorpayRejection(401, 'The api key provided is invalid'),
    );
    const r = await refusal(service.linkAccount(user, 'org1', 'acc_ABCDEFGHIJKLMN'));
    expect(r.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    expect(r.status).toBe(503);
    expect(r.details).toMatchObject({ retryable: false });
  });

  it('says payout setup is not switched on when Route is not enabled for our account', async () => {
    const { service, provider, user } = makeService();
    provider.getConnectedAccount.mockRejectedValue(
      razorpayRejection(400, 'The requested URL was not found on the server.'),
    );
    const r = await refusal(service.linkAccount(user, 'org1', 'acc_ABCDEFGHIJKLMN'));
    expect(r.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
  });

  it('says payout setup is not switched on when this server has no Razorpay keys', async () => {
    const { service, resolver, user } = makeService();
    resolver.get.mockImplementation(() => {
      throw new Error('Razorpay requires RAZORPAY_KEY_ID to be set. Use Razorpay test keys.');
    });
    const r = await refusal(service.linkAccount(user, 'org1', 'acc_ABCDEFGHIJKLMN'));
    expect(r.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    expect(r.status).toBe(503);
    expect(r.message).not.toMatch(/RAZORPAY_KEY_ID/);
  });

  it('says payout setup is not switched on when payments are not activated here', async () => {
    const { service, resolver, user } = makeService();
    resolver.get.mockReturnValue({ name: 'razorpay' }); // the not-activated stand-in
    const r = await refusal(service.linkAccount(user, 'org1', 'acc_ABCDEFGHIJKLMN'));
    expect(r.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    expect(r.status).toBe(503);
  });

  it('links an account Razorpay knows', async () => {
    const { service, user } = makeService();
    const status = await service.linkAccount(user, 'org1', ' acc_ABCDEFGHIJKLMN ');
    expect(status.linkedAccountId).toBe('acc_ABCDEFGHIJKLMN');
    expect(status.onboardingStatus).toBe('ENABLED');
  });
});

describe('RazorpayConnectService.linkAccount - country gate', () => {
  it('refuses a US organization before asking Razorpay anything', async () => {
    const { service, provider, resolver, user } = makeService({
      org: { id: 'org1', registeredCountry: 'US' },
    });
    const r = await refusal(service.linkAccount(user, 'org1', 'acc_ABCDEFGHIJKLMN'));
    expect(r.status).toBe(422);
    expect(r.code).toBe('PAYOUT_COUNTRY_UNSUPPORTED');
    expect(r.details).toMatchObject({ country: 'US' });
    expect(resolver.get).not.toHaveBeenCalled();
    expect(provider.getConnectedAccount).not.toHaveBeenCalled();
  });

  it('asks for the country of registration when it is missing, before asking Razorpay', async () => {
    const { service, provider, resolver, user } = makeService({
      org: { id: 'org1', registeredCountry: null },
    });
    const r = await refusal(service.linkAccount(user, 'org1', 'acc_ABCDEFGHIJKLMN'));
    expect(r.status).toBe(422);
    expect(r.code).toBe('ORGANIZATION_DETAILS_INCOMPLETE');
    expect(r.details).toMatchObject({ fields: ['registeredCountry'] });
    expect(resolver.get).not.toHaveBeenCalled();
    expect(provider.getConnectedAccount).not.toHaveBeenCalled();
  });
});
