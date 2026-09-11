import { HttpStatus, Logger } from '@nestjs/common';
import { FailureClass } from '@eticketsgo/shared-types';
import { PhoneOtpService } from './phone-otp.service';
import { AppException } from '../common/errors';
import { TransportError } from '../notifications/channels/transports/transport-http';
import { classifyTwilioError } from '../notifications/channels/transports/sms.transport';

/**
 * Phone sign-in when the text message cannot be sent.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * The provider's error escaped `requestCode` unhandled. The person got a 500; the exception
 * filter logged the stack and reported it to Sentry, and the provider's message -- which names
 * the number it refused -- went with it. These tests hold the boundary: whatever the provider
 * does, the caller gets one of two plain answers, the code that was never delivered is dead,
 * and nothing the provider said reaches the response or the log.
 */

const PHONE = '+919704464007';
const DIGITS = '9704464007';
const ACCOUNT = `AC${'b'.repeat(32)}`;

function setup(failure: unknown) {
  const prisma = {
    phoneOtp: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'otp-1',
        ...data,
      })),
    },
  };
  const sms = { deliver: jest.fn().mockRejectedValue(failure) };
  const config = { get: (key: string) => (key === 'APP_ENV' ? 'PRODUCTION' : undefined) };
  const service = new PhoneOtpService(prisma as never, sms as never, config as never);
  return { service, prisma };
}

const twilioSays = (code: number, message: string, status = 400) =>
  classifyTwilioError({ code, status, message }, 'twilio');

const CASES: [string, unknown, number, string][] = [
  [
    'a number that does not exist',
    twilioSays(21211, `The 'To' number ${PHONE} is not a valid phone number.`),
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SMS_UNDELIVERABLE',
  ],
  [
    'a recipient who replied STOP',
    twilioSays(21610, `Attempt to send to unsubscribed recipient ${PHONE}`),
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SMS_UNDELIVERABLE',
  ],
  [
    'a rejected credential',
    twilioSays(20003, `Authenticate failed for ${ACCOUNT}`, 401),
    HttpStatus.SERVICE_UNAVAILABLE,
    'SMS_UNAVAILABLE',
  ],
  [
    'a provider rate limit',
    twilioSays(20429, 'Too Many Requests', 429),
    HttpStatus.SERVICE_UNAVAILABLE,
    'SMS_UNAVAILABLE',
  ],
  [
    'a destination no provider is routed for',
    new TransportError(
      'No SMS provider configured for this destination (unsupported_market, market IN).',
      'router',
      FailureClass.CONFIGURATION_ERROR,
    ),
    HttpStatus.SERVICE_UNAVAILABLE,
    'SMS_UNAVAILABLE',
  ],
  [
    'a provider outage',
    new TransportError('twilio request timed out', 'twilio', FailureClass.TEMPORARY_PROVIDER_ERROR),
    HttpStatus.SERVICE_UNAVAILABLE,
    'SMS_UNAVAILABLE',
  ],
  [
    'something nobody classified',
    new Error(`socket hang up while sending to ${PHONE}`),
    HttpStatus.SERVICE_UNAVAILABLE,
    'SMS_UNAVAILABLE',
  ],
];

describe('phone sign-in when the code cannot be sent', () => {
  let logSpies: jest.SpyInstance[];
  beforeEach(() => {
    logSpies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logSpies.forEach((s) => s.mockRestore()));
  const logText = () =>
    logSpies
      .flatMap((s) => s.mock.calls)
      .flat()
      .map(String)
      .join('\n');

  it.each(CASES)('%s becomes a plain application error', async (_name, failure, status, code) => {
    const { service } = setup(failure);
    const err = (await service.requestCode(PHONE).catch((e) => e)) as AppException;

    expect(err).toBeInstanceOf(AppException);
    expect(err).not.toBeInstanceOf(TransportError);
    expect(err.getStatus()).toBe(status);
    expect(err).toMatchObject({ code });

    // Nothing the provider said, and nothing about the person, reaches the caller.
    const response = JSON.stringify({ message: err.message, body: err.getResponse() });
    for (const leak of [DIGITS, 'twilio', 'Twilio', ACCOUNT, '21211', '21610', '20003', 'router']) {
      expect(response).not.toContain(leak);
    }
    expect(response).not.toMatch(/at \w+ \(/); // no stack frames
  });

  it.each(CASES)('%s leaves nothing sensitive in the log', async (_name, failure) => {
    const { service } = setup(failure);
    await service.requestCode(PHONE).catch(() => undefined);
    const text = logText();
    expect(text).not.toContain(DIGITS);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toMatch(/'To' number/);
    // What IS there is enough to act on: a masked number and the failure class.
    expect(text).toContain('••••••4007');
  });

  it.each(CASES)('%s kills the code that was never delivered', async (_name, failure) => {
    const { service, prisma } = setup(failure);
    await service.requestCode(PHONE).catch(() => undefined);
    const last = prisma.phoneOtp.updateMany.mock.calls.at(-1)?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(last.where).toMatchObject({ phone: PHONE, consumedAt: null });
    expect(last.data.consumedAt).toBeInstanceOf(Date);
  });

  it('gives a dead number and an opt-out the SAME answer, so neither can be probed for', async () => {
    const dead = (await setup(CASES[0][1])
      .service.requestCode(PHONE)
      .catch((e) => e)) as Error;
    const stopped = (await setup(CASES[1][1])
      .service.requestCode(PHONE)
      .catch((e) => e)) as Error;
    expect(dead.message).toBe(stopped.message);
  });
});
