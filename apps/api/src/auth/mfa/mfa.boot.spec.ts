import { randomBytes } from 'node:crypto';
import { MfaService } from './mfa.service';

/*
  The first deploy of this feature must not brick the API, and a later deploy that LOSES the
  key must not quietly turn MFA off. Both are decided in onModuleInit.
*/
function build(env: Record<string, string | undefined>, enrolled: number) {
  const prisma = {
    adminMfaCredential: { count: jest.fn().mockResolvedValue(enrolled) },
    adminMfaBreakGlassUse: { findUnique: jest.fn() },
  };
  const config = { get: (k: string) => env[k], getOrThrow: (k: string) => env[k] };
  const svc = new MfaService(
    prisma as never,
    config as never,
    { record: jest.fn() } as never,
    {} as never,
  );
  return { svc, prisma };
}

const KEY = randomBytes(32).toString('base64');

describe('MFA boot check', () => {
  it('first deploy (no key, nothing enrolled) boots in PRODUCTION and stays dormant', async () => {
    const { svc } = build({ APP_ENV: 'PRODUCTION' }, 0);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(svc.enabled).toBe(false);
  });

  it('refuses to boot in PRODUCTION, STAGING, QA and UAT when authenticators exist but the key is gone', async () => {
    for (const APP_ENV of ['PRODUCTION', 'STAGING', 'QA', 'UAT']) {
      const { svc } = build({ APP_ENV }, 1);
      await expect(svc.onModuleInit()).rejects.toThrow(/MFA_ENCRYPTION_KEY is not set/);
    }
  });

  it('does not block a laptop (LOCAL) that has leftover rows and no key', async () => {
    const { svc } = build({ APP_ENV: 'LOCAL' }, 3);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('with the key present it boots and is armed, without even counting rows', async () => {
    const { svc, prisma } = build({ APP_ENV: 'PRODUCTION', MFA_ENCRYPTION_KEY: KEY }, 5);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(svc.enabled).toBe(true);
    expect(prisma.adminMfaCredential.count).not.toHaveBeenCalled();
  });

  it('treats a database that has not been migrated yet as nothing enrolled', async () => {
    const { svc, prisma } = build({ APP_ENV: 'PRODUCTION' }, 0);
    prisma.adminMfaCredential.count.mockRejectedValue({ code: 'P2021' });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('rejects a key that is not 32 bytes at construction', () => {
    expect(() => build({ MFA_ENCRYPTION_KEY: randomBytes(8).toString('base64') }, 0)).toThrow(
      /32 bytes/,
    );
  });
});
