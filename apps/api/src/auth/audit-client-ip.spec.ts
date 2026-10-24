import 'reflect-metadata';
import type { Request } from 'express';
import { AuthController } from './auth.controller';
import { MfaController } from './mfa/mfa.controller';
import { requestClientIp } from '../common/client-ip';

/**
 * unit - what the auth and MFA routes record as "the client's address".
 *
 * Behind Railway `req.ip` is the edge node that carried the request, so audit rows and session
 * rows that stored it named the same couple of proxies for every customer. They now store the
 * address the throttle counts (common/client-ip.ts): Railway's X-Real-IP when Railway is in
 * front, `req.ip` anywhere else.
 */
const EDGE = '100.64.0.7';
const CLIENT = '198.51.100.9';

function request(headers: Record<string, string> = { 'x-real-ip': CLIENT }): Request {
  return {
    headers: { 'user-agent': 'jest', ...headers },
    header: (name: string) => ({ 'user-agent': 'jest', ...headers })[name.toLowerCase()],
    ip: EDGE,
  } as unknown as Request;
}

describe('auth audit and session rows record the client, not the edge', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-123';
    delete process.env.THROTTLE_CLIENT_IP_HEADER;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('requestClientIp reads X-Real-IP on Railway and req.ip elsewhere', () => {
    expect(requestClientIp(request())).toBe(CLIENT);
    delete process.env.RAILWAY_ENVIRONMENT_ID;
    // Off Railway nothing overwrites the header, so a client could choose its own address.
    expect(requestClientIp(request())).toBe(EDGE);
  });

  it.each([
    'login',
    'register',
    'refresh',
    'forgotPassword',
    'resetPassword',
    'logoutAll',
  ] as const)('POST /auth %s passes the client address to the service', async (route) => {
    const seen: unknown[] = [];
    const auth = new Proxy(
      {},
      {
        get:
          () =>
          async (...args: unknown[]) => {
            seen.push(...args);
            return {};
          },
      },
    );
    const controller = new AuthController(auth as never, {} as never);
    const req = request();
    const body = { email: 'a@example.com', password: 'x', refreshToken: 'r', token: 't' };
    if (route === 'logoutAll') {
      await controller.logoutAll({ id: 'u1' } as never, req);
    } else {
      await (controller[route] as (b: unknown, r: Request) => Promise<unknown>).call(
        controller,
        body,
        req,
      );
    }
    expect(seen).toContainEqual(expect.objectContaining({ ip: CLIENT }));
    expect(seen).not.toContainEqual(expect.objectContaining({ ip: EDGE }));
  });

  it('POST /auth/mfa/verify passes the client address to the MFA check and the session', async () => {
    const mfa = {
      readChallenge: jest.fn().mockResolvedValue('u1'),
      verify: jest
        .fn()
        .mockResolvedValue({ credentialId: 'c', verifiedAt: new Date(), method: 'totp' }),
    };
    const auth = { issueMfaSession: jest.fn().mockResolvedValue({}) };
    const controller = new MfaController(mfa as never, auth as never, {} as never);
    await controller.verify({ challengeToken: 'x'.repeat(30), code: '123456' }, request());
    expect(mfa.verify.mock.calls[0][2]).toMatchObject({ ip: CLIENT });
    expect(auth.issueMfaSession.mock.calls[0][1]).toMatchObject({ ip: CLIENT });
  });
});
