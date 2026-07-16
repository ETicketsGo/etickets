import { AuthService } from './auth.service';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * Refresh-token rotation + reuse detection. Prisma/JWT/config are mocked; we
 * assert the rotation chain rotates normally and that replaying an already
 * revoked token burns the whole family (compromise response).
 */
function setup(recordOverrides: Record<string, unknown> | null) {
  const now = new Date();
  const record =
    recordOverrides === null
      ? null
      : {
          id: 'rt-old',
          userId: 'u1',
          tokenHash: 'hash-old',
          revokedAt: null as Date | null,
          replacedByTokenId: null as string | null,
          expiresAt: new Date(now.getTime() + 1000 * 60 * 60 * 24), // +1d
          ...recordOverrides,
        };

  const refreshToken = {
    // First call → the presented record; second call → the freshly-created replacement.
    findUnique: jest.fn().mockResolvedValueOnce(record).mockResolvedValueOnce({ id: 'rt-new' }),
    create: jest.fn().mockResolvedValue({ id: 'rt-new' }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 3 }),
  };
  const prisma = {
    refreshToken,
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'u1@x.test',
        fullName: 'U One',
        roles: ['CUSTOMER'],
      }),
    },
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
  const config = {
    getOrThrow: jest.fn().mockReturnValue('access-secret'),
    get: jest.fn((_key: string, def?: string) => def),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthService(prisma as never, jwt as never, config as never, audit as never);
  return { service, prisma, refreshToken, audit };
}

describe('AuthService.refresh reuse detection', () => {
  const meta = { userAgent: 'jest', ip: '127.0.0.1' };

  it('rotates a valid token: revokes the used token and issues a fresh pair', async () => {
    const { service, refreshToken } = setup({});
    const tokens = await service.refresh('presented-token', meta);

    expect(tokens.accessToken).toBe('access-token');
    expect(typeof tokens.refreshToken).toBe('string');
    // New refresh row created …
    expect(refreshToken.create).toHaveBeenCalledTimes(1);
    // … and the presented (old) token revoked + linked to its replacement.
    expect(refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt-old' },
        data: expect.objectContaining({ replacedByTokenId: 'rt-new' }),
      }),
    );
    // Happy path must NOT nuke the family.
    expect(refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('replaying an already-revoked token revokes the whole family and rejects', async () => {
    const { service, refreshToken } = setup({ revokedAt: new Date() });

    await expect(service.refresh('replayed-token', meta)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
    // Compromise response: revoke every still-active token for the user.
    expect(refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    // No rotation happened.
    expect(refreshToken.create).not.toHaveBeenCalled();
    expect(refreshToken.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown token without touching the family', async () => {
    const { service, refreshToken } = setup(null);
    await expect(service.refresh('nope', meta)).rejects.toBeInstanceOf(AppException);
    expect(refreshToken.updateMany).not.toHaveBeenCalled();
    expect(refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects an expired (but not revoked) token without burning the family', async () => {
    const { service, refreshToken } = setup({ expiresAt: new Date(Date.now() - 1000) });
    await expect(service.refresh('stale', meta)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
    expect(refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
