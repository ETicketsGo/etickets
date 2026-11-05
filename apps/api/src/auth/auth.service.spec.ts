import * as bcrypt from 'bcryptjs';
import { AuthService, DUMMY_PASSWORD_HASH, REFRESH_REUSE_GRACE_MS } from './auth.service';
import { LoginBackoff } from './login-backoff';
import { ErrorCodes } from '../common/errors';

// The real bcrypt, with `compare` observable: the timing tests count comparisons, not milliseconds.
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual('bcryptjs');
  return { ...actual, compare: jest.fn((...args: unknown[]) => actual.compare(...args)) };
});

/**
 * Sign-in and session handling against an in-memory stand-in for the two tables involved.
 *
 * The stand-in is deliberately a small DATABASE rather than a list of canned replies: the race
 * tests need `updateMany ... WHERE revokedAt IS NULL` to behave like the real thing (exactly one
 * of two concurrent writers matches), and canned replies would only prove the canned replies.
 */

interface TokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  ip?: string;
  userAgent?: string;
}

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  status: string;
  passwordHash: string;
}

const PASSWORD = 'correct horse battery staple';
// Cost 4: the real comparison runs, fast. The regex accepts any cost, as bcrypt does.
const HASH = bcrypt.hashSync(PASSWORD, 4);

function setup(users: Partial<UserRow>[] = [{}]) {
  const userRows: UserRow[] = users.map((u, i) => ({
    id: `u${i + 1}`,
    email: `u${i + 1}@example.com`,
    fullName: `User ${i + 1}`,
    roles: ['CUSTOMER'],
    status: 'ACTIVE',
    passwordHash: HASH,
    ...u,
  }));
  const tokens: TokenRow[] = [];
  let seq = 0;
  const matches = (row: TokenRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
  // Every call yields once first, so two concurrent requests really do interleave.
  const tick = () => new Promise((r) => setImmediate(r));

  const refreshToken = {
    findUnique: jest.fn(async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
      await tick();
      const row = tokens.find((t) =>
        where.id ? t.id === where.id : t.tokenHash === where.tokenHash,
      );
      return row ? { ...row, mfa: null } : null;
    }),
    create: jest.fn(async ({ data }: { data: Partial<TokenRow> }) => {
      await tick();
      const row = Object.assign(
        { id: `rt-${++seq}`, revokedAt: null, replacedByTokenId: null },
        data,
      ) as TokenRow;
      tokens.push(row);
      return row;
    }),
    updateMany: jest.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Partial<TokenRow> }) => {
        await tick();
        // Synchronous from here on: the database applies one statement atomically.
        let count = 0;
        for (const t of tokens) {
          if (matches(t, where)) {
            Object.assign(t, data);
            count++;
          }
        }
        return { count };
      },
    ),
  };
  const prisma: Record<string, unknown> = {
    refreshToken,
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        await tick();
        const u = userRows.find((r) => (where.id ? r.id === where.id : r.email === where.email));
        return u ? { ...u } : null;
      }),
    },
    passwordResetToken: { updateMany: jest.fn(), create: jest.fn() },
    authHandoff: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
      fn(prisma),
    ),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
  const config = {
    getOrThrow: jest.fn().mockReturnValue('access-secret'),
    get: jest.fn((key: string, def?: string) =>
      key === 'CUSTOMER_WEB_URL' ? 'https://x.test' : def,
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };
  const backoff = new LoginBackoff();
  const service = new AuthService(
    prisma as never,
    jwt as never,
    config as never,
    audit as never,
    notifications as never,
    undefined,
    undefined,
    backoff,
  );
  const live = (userId = 'u1') => tokens.filter((t) => t.userId === userId && !t.revokedAt);
  return { service, prisma, refreshToken, tokens, userRows, audit, notifications, backoff, live };
}

const meta = { userAgent: 'jest', ip: '203.0.113.7' };

// Unknown-address cases pay a real cost-12 comparison each (that is the point), which is slow.
jest.setTimeout(120_000);

describe('AuthService.login', () => {
  const compare = bcrypt.compare as unknown as jest.Mock;
  beforeEach(() => compare.mockClear());

  it('signs in with the right password and records the client address on the session', async () => {
    const { service, tokens } = setup();
    const result = await service.login({ email: 'u1@example.com', password: PASSWORD }, meta);
    expect(result).toMatchObject({ accessToken: 'access-token' });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].ip).toBe('203.0.113.7');
  });

  it('an unknown address costs one bcrypt comparison, exactly as a wrong password does', async () => {
    const { service } = setup();
    await expect(
      service.login({ email: 'nobody@example.com', password: 'whatever-it-is' }, meta),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_CREDENTIALS });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenLastCalledWith('whatever-it-is', DUMMY_PASSWORD_HASH);

    compare.mockClear();
    await expect(
      service.login({ email: 'u1@example.com', password: 'whatever-it-is' }, meta),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_CREDENTIALS });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenLastCalledWith('whatever-it-is', HASH);
  });

  it('the stand-in hash is a real cost-12 hash that nothing matches', async () => {
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(12);
    expect(await bcrypt.compare('', DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it('a placeholder hash (phone-only or invited account) also compares against the stand-in', async () => {
    const { service } = setup([{ passwordHash: 'phone-only$not-a-real-hash' }]);
    await expect(
      service.login({ email: 'u1@example.com', password: 'phone-only$not-a-real-hash' }, meta),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_CREDENTIALS });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenLastCalledWith(expect.any(String), DUMMY_PASSWORD_HASH);
  });

  it('after five wrong passwords that account waits - and only that account', async () => {
    const { service } = setup([{}, {}]);
    const wrong = { email: 'u1@example.com', password: 'wrong-password' };
    for (let i = 0; i < 5; i++) {
      await expect(service.login(wrong, meta)).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CREDENTIALS,
      });
    }
    // Now even the RIGHT password is not checked: the wait is the point.
    compare.mockClear();
    await expect(
      service.login({ email: 'u1@example.com', password: PASSWORD }, meta),
    ).rejects.toMatchObject({ code: ErrorCodes.RATE_LIMITED, status: 429 });
    expect(compare).not.toHaveBeenCalled();
    // Another account, same client address, is untouched.
    await expect(
      service.login({ email: 'u2@example.com', password: PASSWORD }, meta),
    ).resolves.toMatchObject({ accessToken: 'access-token' });
  });

  it('an address with no account waits exactly like one with an account', async () => {
    const { service } = setup();
    const probe = { email: 'nobody@example.com', password: 'guess' };
    for (let i = 0; i < 5; i++) await expect(service.login(probe, meta)).rejects.toBeDefined();
    await expect(service.login(probe, meta)).rejects.toMatchObject({
      code: ErrorCodes.RATE_LIMITED,
    });
  });

  it('the waiting message is plain and never says whether the account exists', async () => {
    const { service } = setup();
    const known = { email: 'u1@example.com', password: 'nope' };
    const unknown = { email: 'nobody@example.com', password: 'nope' };
    for (let i = 0; i < 5; i++) {
      await service.login(known, meta).catch(() => undefined);
      await service.login(unknown, meta).catch(() => undefined);
    }
    const a = await service.login(known, meta).catch((e: Error) => e.message);
    const b = await service.login(unknown, meta).catch((e: Error) => e.message);
    expect(a).toBe(b);
    expect(a).toMatch(/^Too many wrong passwords for this email\. Wait 1 minute/);
    expect(a).toMatch(/^[\x20-\x7e]+$/);
  });

  it('a successful sign-in starts the count again', async () => {
    const { service } = setup();
    const wrong = { email: 'u1@example.com', password: 'wrong-password' };
    for (let i = 0; i < 4; i++) await service.login(wrong, meta).catch(() => undefined);
    await service.login({ email: 'u1@example.com', password: PASSWORD }, meta);
    // Four more wrong ones are allowed again before any wait.
    for (let i = 0; i < 4; i++) {
      await expect(service.login(wrong, meta)).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CREDENTIALS,
      });
    }
  });

  it.each(['SUSPENDED', 'DELETED'])(
    'refuses a %s account even with the right password',
    async (status) => {
      const { service, tokens } = setup([{ status }]);
      await expect(
        service.login({ email: 'u1@example.com', password: PASSWORD }, meta),
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'This account cannot sign in.',
      });
      expect(tokens).toHaveLength(0);
    },
  );

  it('records the client address on the failure audit', async () => {
    const { service, audit } = setup();
    await service.login({ email: 'u1@example.com', password: 'nope' }, meta).catch(() => undefined);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_LOGIN_FAILED', ip: '203.0.113.7' }),
    );
  });
});

describe('AuthService.refresh', () => {
  async function signedIn(users?: Partial<UserRow>[]) {
    const ctx = setup(users);
    const tokens = await ctx.service.login({ email: 'u1@example.com', password: PASSWORD }, meta);
    return { ...ctx, first: (tokens as { refreshToken: string }).refreshToken };
  }

  it('rotates: the old token is spent and linked to its replacement', async () => {
    const { service, tokens, first, live } = await signedIn();
    const next = await service.refresh(first, meta);
    expect(next.refreshToken).not.toBe(first);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].revokedAt).toBeInstanceOf(Date);
    expect(tokens[0].replacedByTokenId).toBe(tokens[1].id);
    expect(live()).toHaveLength(1);
  });

  it('two refreshes racing with one token: exactly one wins, and the family is not burned', async () => {
    const { service, first, live, audit } = await signedIn();
    const results = await Promise.allSettled([
      service.refresh(first, meta),
      service.refresh(first, meta),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ code: ErrorCodes.INVALID_REFRESH_TOKEN });
    // The winner's new session is the one live session left: the loser's pair never works.
    const winner = (won[0] as PromiseFulfilledResult<{ refreshToken: string }>).value;
    expect(live()).toHaveLength(1);
    await expect(service.refresh(winner.refreshToken, meta)).resolves.toBeDefined();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_TOKEN_REUSE_DETECTED' }),
    );
  });

  it('a second tab presenting the just-rotated token inside the grace window is refused, nothing burned', async () => {
    const { service, first, live } = await signedIn();
    await service.refresh(first, meta);
    await expect(service.refresh(first, meta)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
    expect(live()).toHaveLength(1);
  });

  it('the same token presented after the grace window is a replay: the whole family is burned', async () => {
    const { service, first, live, tokens, audit } = await signedIn();
    await service.refresh(first, meta);
    // Age the rotation past the window.
    tokens[0].revokedAt = new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1);
    await expect(service.refresh(first, meta)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
    expect(live()).toHaveLength(0);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_TOKEN_REUSE_DETECTED', ip: '203.0.113.7' }),
    );
  });

  it('a token that was signed out (not rotated) is a replay at once: no grace', async () => {
    const { service, first, live } = await signedIn();
    // A second session that the burn must reach.
    await service.login({ email: 'u1@example.com', password: PASSWORD }, meta);
    await service.logout(first);
    await expect(service.refresh(first, meta)).rejects.toBeDefined();
    expect(live()).toHaveLength(0);
  });

  it('rejects an unknown token without touching the family', async () => {
    const { service, live } = await signedIn();
    await expect(service.refresh('nope', meta)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
    expect(live()).toHaveLength(1);
  });

  it('rejects an expired (but not revoked) token without burning the family', async () => {
    const { service, first, tokens, live } = await signedIn();
    tokens[0].expiresAt = new Date(Date.now() - 1000);
    await expect(service.refresh(first, meta)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
    expect(live()).toHaveLength(1);
  });

  it('a suspended account cannot renew its session', async () => {
    const { service, first, userRows, tokens } = await signedIn();
    userRows[0].status = 'SUSPENDED';
    await expect(service.refresh(first, meta)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
    expect(tokens).toHaveLength(1);
  });
});

describe('AuthService.logoutAll', () => {
  it('revokes every session the account holds, and no other account', async () => {
    const { service, live, audit } = setup([{}, {}]);
    for (let i = 0; i < 3; i++) {
      await service.login({ email: 'u1@example.com', password: PASSWORD }, meta);
    }
    await service.login({ email: 'u2@example.com', password: PASSWORD }, meta);
    expect(await service.logoutAll('u1', meta)).toBe(3);
    expect(live('u1')).toHaveLength(0);
    expect(live('u2')).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_LOGOUT_ALL', ip: '203.0.113.7' }),
    );
  });

  it('also revokes any organizer console handoff code the account has in flight', async () => {
    const { service, prisma } = setup();
    await service.logoutAll('u1', meta);
    expect((prisma.authHandoff as { updateMany: jest.Mock }).updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', consumedAt: null, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe('AuthService.logout', () => {
  it('revokes the session and the handoff codes of the account it belonged to', async () => {
    const { service, prisma, tokens } = setup();
    const { refreshToken } = (await service.login(
      { email: 'u1@example.com', password: PASSWORD },
      meta,
    )) as { refreshToken: string };
    await service.logout(refreshToken);
    expect(tokens.every((t) => t.revokedAt)).toBe(true);
    expect((prisma.authHandoff as { updateMany: jest.Mock }).updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1' }) }),
    );
  });
});

describe('AuthService.requestPasswordReset', () => {
  it('takes about as long for an unknown address as for a real one', async () => {
    const hit = setup();
    const miss = setup();
    const time = async (fn: () => Promise<unknown>) => {
      const started = Date.now();
      await fn();
      return Date.now() - started;
    };
    const hitMs = await time(() => hit.service.requestPasswordReset('u1@example.com', meta));
    const missMs = await time(() => miss.service.requestPasswordReset('nobody@example.com', meta));
    // The real one really did the work, so the sameness is not sameness of doing nothing.
    expect(hit.notifications.send).toHaveBeenCalledTimes(1);
    expect(miss.notifications.send).not.toHaveBeenCalled();
    expect(missMs).toBeGreaterThanOrEqual(200);
    expect(Math.abs(hitMs - missMs)).toBeLessThan(150);
  });
});
