import { AuthService } from './auth.service';

/**
 * One email address, one account — and a password the policy accepts.
 *
 * ── THE GAPS ───────────────────────────────────────────────────────────────────────
 * Registration looked the address up by exact string. The schema lowercases input, so new
 * sign-ups were fine, but a row stored before it did would let `asha@example.com` register a
 * second account beside `Asha@Example.com`. And look-up-then-insert is a race: two submissions
 * of one form both found nothing, both inserted, and the unique index refused the second as a
 * 500.
 *
 * Separately, the password rule was eight characters and nothing else, enforced only by the
 * request schema — which cannot know whose account a reset link belongs to.
 */

function build(over: { existing?: unknown; createError?: unknown; resetRow?: unknown } = {}) {
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue(over.existing ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (over.createError) throw over.createError;
        return { id: 'user-new', ...data };
      }),
    },
    passwordResetToken: { findUnique: jest.fn().mockResolvedValue(over.resetRow ?? null) },
    $transaction: jest.fn(),
  };
  const service = new AuthService(
    prisma as never,
    {} as never,
    { get: () => undefined, getOrThrow: () => 'secret' } as never,
    { record: async () => undefined } as never,
    { send: async () => undefined } as never,
  );
  // Token issuance is not what these tests are about.
  (service as unknown as Record<string, unknown>).issueTokens = jest
    .fn()
    .mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
  return { service, prisma };
}

const signUp = (over: Record<string, string> = {}) =>
  ({
    email: 'asha.menon@example.test',
    password: 'Blue-Lantern-Harbour-47',
    fullName: 'Asha Menon',
    ...over,
  }) as never;

describe('registering an account', () => {
  it('looks the address up without regard to case', async () => {
    const { service, prisma } = build();
    await service.register(signUp(), {});
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'asha.menon@example.test', mode: 'insensitive' } },
      select: { id: true },
    });
  });

  it('refuses when an account already exists under a different case', async () => {
    const { service, prisma } = build({ existing: { id: 'legacy-mixed-case' } });
    await expect(service.register(signUp(), {})).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('tells the loser of a double submission the address is taken, not a server error', async () => {
    const { service } = build({
      createError: Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), {
        code: 'P2002',
      }),
    });
    await expect(service.register(signUp(), {})).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
    });
  });

  it('does not disguise an unrelated database failure as a duplicate', async () => {
    const { service } = build({ createError: Object.assign(new Error('down'), { code: 'P1001' }) });
    await expect(service.register(signUp(), {})).rejects.toMatchObject({ code: 'P1001' });
  });

  it('refuses the phone sign-in domain before looking anything up', async () => {
    const { service, prisma } = build();
    await expect(
      service.register(signUp({ email: 'phone+919704464007@users.eticketsgo.internal' }), {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a password made of the person’s own name, even if a caller skipped the schema', async () => {
    const { service, prisma } = build();
    await expect(
      service.register(signUp({ password: 'Menon-Harbour-4747' }), {}),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { passwordProblems: expect.arrayContaining(['CONTAINS_PERSONAL_INFO']) },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('creates the account when the address is new and the password is sound', async () => {
    const { service, prisma } = build();
    await expect(service.register(signUp(), {})).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });
});

describe('choosing a new password from a reset link', () => {
  const validLink = {
    userId: 'user-1',
    usedAt: null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    user: {
      id: 'user-1',
      email: 'asha.menon@example.test',
      status: 'ACTIVE',
      fullName: 'Asha Menon',
    },
  };

  it('refuses a password containing the account holder’s address, and leaves the link usable', async () => {
    /*
      The request schema cannot apply this — it does not know whose link it is. And the link
      must survive the refusal, or the person is sent back to request another email.
    */
    const { service, prisma } = build({ resetRow: validLink });
    await expect(
      service.resetPassword('a-reset-token-of-sufficient-length', 'ashamenon-harbour', {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a common password too', async () => {
    const { service, prisma } = build({ resetRow: validLink });
    await expect(
      service.resetPassword('a-reset-token-of-sufficient-length', 'Password123!', {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
