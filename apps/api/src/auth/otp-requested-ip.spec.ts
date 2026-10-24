import 'reflect-metadata';
import type { Request } from 'express';
import { AuthController } from './auth.controller';

/**
 * unit - the address recorded against a sign-in code request is the CLIENT, not Railway's edge.
 *
 * `PhoneOtp.requestedIp` exists for abuse investigation. It was `req.ip`, which behind Railway is
 * the edge proxy node, so every row named one of a few proxies. It now uses the same rule the
 * throttler uses (`common/client-ip.ts`).
 */
function request(over: { ip?: string; headers?: Record<string, string> } = {}): Request {
  return {
    ip: over.ip ?? '10.250.0.9',
    headers: over.headers ?? {},
    socket: {},
    header: () => undefined,
  } as unknown as Request;
}

function controller(env: Record<string, string | undefined>) {
  const otp = { requestCode: jest.fn().mockResolvedValue({ sent: true, expiresInMinutes: 10 }) };
  const config = { get: (k: string) => env[k] };
  const ctl = new AuthController({} as never, otp as never, config as never);
  return { ctl, otp };
}

describe('sign-in code requests record the client address', () => {
  it('uses the trusted client header, not the edge proxy in req.ip', async () => {
    const { ctl, otp } = controller({ THROTTLE_CLIENT_IP_HEADER: 'x-real-ip' });
    await ctl.requestPhoneCode(
      { phone: '+919704464007' },
      request({ headers: { 'x-real-ip': '203.0.113.7' } }),
    );
    expect(otp.requestCode).toHaveBeenCalledWith('+919704464007', '203.0.113.7');
  });

  it('does the same on the signed-in "add a number" route', async () => {
    const { ctl, otp } = controller({ THROTTLE_CLIENT_IP_HEADER: 'x-real-ip' });
    await ctl.requestAttachCode(
      { phone: '+919704464007' },
      request({ headers: { 'x-real-ip': '198.51.100.4' } }),
    );
    expect(otp.requestCode).toHaveBeenCalledWith('+919704464007', '198.51.100.4');
  });

  it('falls back to req.ip where no trusted header is configured (off Railway)', async () => {
    const saved = process.env.RAILWAY_ENVIRONMENT_ID;
    delete process.env.RAILWAY_ENVIRONMENT_ID;
    try {
      const { ctl, otp } = controller({});
      // A header nobody configured is client-controlled, so it must be ignored.
      await ctl.requestPhoneCode(
        { phone: '+919704464007' },
        request({ ip: '192.0.2.10', headers: { 'x-real-ip': '203.0.113.7' } }),
      );
      expect(otp.requestCode).toHaveBeenCalledWith('+919704464007', '192.0.2.10');
    } finally {
      if (saved !== undefined) process.env.RAILWAY_ENVIRONMENT_ID = saved;
    }
  });
});
