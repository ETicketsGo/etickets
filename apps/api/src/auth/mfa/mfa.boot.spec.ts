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

/*
  What JwtStrategy hands MfaGuard for a back-office account, per MFA_ENROLLMENT. The guard's
  decisions on these states are in mfa.guard.spec.ts; this is where the states come from.
*/
describe('MFA session state by MFA_ENROLLMENT', () => {
  function svcWith(env: Record<string, string | undefined>, cred: object | null) {
    const prisma = {
      adminMfaCredential: { findUnique: jest.fn().mockResolvedValue(cred) },
    };
    const config = { get: (k: string) => env[k], getOrThrow: (k: string) => env[k] };
    return new MfaService(
      prisma as never,
      config as never,
      { record: jest.fn() } as never,
      {} as never,
    );
  }
  const ADMIN = ['CUSTOMER', 'ADMIN'];
  const enrolledCred = { id: 'c1', confirmedAt: new Date() };

  it('required + key: the console needs MFA whether or not the account has enrolled', async () => {
    const svc = svcWith({ APP_ENV: 'PRODUCTION', MFA_ENCRYPTION_KEY: KEY }, null);
    expect(svc.enrollment).toBe('required');
    expect(await svc.sessionState('u', ADMIN, {})).toEqual({
      required: true,
      enrolled: false,
      verified: false,
      verifiedAt: null,
      stepUp: 'available',
    });
  });

  it('deferred + key, not enrolled: the console is open, step-up waits for enrollment', async () => {
    const svc = svcWith(
      { APP_ENV: 'PRODUCTION', MFA_ENCRYPTION_KEY: KEY, MFA_ENROLLMENT: 'deferred' },
      null,
    );
    expect(await svc.sessionState('u', ADMIN, {})).toMatchObject({
      required: false,
      enrolled: false,
      stepUp: 'available',
    });
    expect(await svc.requiresChallenge('u', ADMIN)).toBe(false);
  });

  it('deferred + key, enrolled: held to the full rule, exactly as in required mode', async () => {
    const svc = svcWith(
      { APP_ENV: 'PRODUCTION', MFA_ENCRYPTION_KEY: KEY, MFA_ENROLLMENT: 'deferred' },
      enrolledCred,
    );
    expect(await svc.sessionState('u', ADMIN, {})).toMatchObject({
      required: true,
      enrolled: true,
      verified: false,
    });
    expect(await svc.requiresChallenge('u', ADMIN)).toBe(true);
  });

  it('no key: step-up is blocked everywhere but a LOCAL/DEV machine in required mode', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ APP_ENV: 'PRODUCTION', MFA_ENROLLMENT: 'deferred' }, 'unconfigured'],
      [{ APP_ENV: 'STAGING', MFA_ENROLLMENT: 'deferred' }, 'unconfigured'],
      [{ APP_ENV: 'QA' }, 'unconfigured'],
      [{ APP_ENV: 'UAT' }, 'unconfigured'],
      [{ APP_ENV: 'LOCAL', MFA_ENROLLMENT: 'deferred' }, 'unconfigured'],
      [{ APP_ENV: 'LOCAL' }, 'dormant'],
      [{ APP_ENV: 'DEV' }, 'dormant'],
    ];
    for (const [env, expected] of cases) {
      const state = await svcWith(env, null).sessionState('u', ADMIN, {});
      expect({ env, stepUp: state.stepUp, required: state.required }).toEqual({
        env,
        stepUp: expected,
        required: false,
      });
    }
  });

  it('an unknown MFA_ENROLLMENT value in a hand-built config reads as required (stricter)', () => {
    expect(svcWith({ MFA_ENROLLMENT: 'Deferred' }, null).enrollment).toBe('required');
  });

  it('customers and organizers carry no MFA requirement in either mode', async () => {
    for (const MFA_ENROLLMENT of ['required', 'deferred']) {
      const svc = svcWith({ MFA_ENCRYPTION_KEY: KEY, MFA_ENROLLMENT }, enrolledCred);
      expect((await svc.sessionState('u', ['CUSTOMER', 'ORGANIZER_OWNER'], {})).required).toBe(
        false,
      );
      expect(await svc.requiresChallenge('u', ['CUSTOMER'])).toBe(false);
    }
  });
});

describe('MFA boot warning when enrollment is deferred', () => {
  const spyWarn = (svc: MfaService) =>
    jest
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

  it('PRODUCTION + deferred + no key boots and says, once, that sensitive actions are blocked', async () => {
    const { svc } = build({ APP_ENV: 'PRODUCTION', MFA_ENROLLMENT: 'deferred' }, 0);
    const warn = spyWarn(svc);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/BLOCKED until an operator sets MFA_ENCRYPTION_KEY/);
  });

  it('PRODUCTION + deferred + no key still refuses to boot when authenticators exist', async () => {
    const { svc } = build({ APP_ENV: 'PRODUCTION', MFA_ENROLLMENT: 'deferred' }, 2);
    await expect(svc.onModuleInit()).rejects.toThrow(/MFA_ENCRYPTION_KEY is not set/);
  });

  it('PRODUCTION + deferred + key boots and warns that enrollment is optional', async () => {
    const { svc } = build(
      { APP_ENV: 'PRODUCTION', MFA_ENROLLMENT: 'deferred', MFA_ENCRYPTION_KEY: KEY },
      0,
    );
    const warn = spyWarn(svc);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DEFERRED/);
  });
});
