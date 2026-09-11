import { PhoneOtpService } from './phone-otp.service';
import { SmsChannel } from '../notifications/channels/sms.channel';
import { NotificationProviderResolver } from '../notifications/channels/notification-provider.resolver';
import type { RenderedNotification } from '../notifications/channels/notification-channel.interface';

/**
 * Sign-in codes never appear in a deployed environment's log.
 *
 * ── WHY THIS DRIVES THE REAL CHANNEL AND WATCHES THE REAL STREAMS ──────────────────
 * The leak was a chain: the sign-in service hands the code to the SMS channel, the resolver
 * routes it to the log transport, and that transport printed the body. Each link looked
 * harmless alone. So nothing here is mocked between the service and the process's own stdout
 * and stderr -- which is where a Railway log line comes from -- and the assertion is on what was
 * actually written, not on which logger method was called.
 *
 * The LOCAL case is the control: it proves the capture sees the code when it IS printed, so a
 * passing QA case means "withheld", not "the capture was broken".
 */

const PHONE = '+919704464007';

function captureStreams() {
  const written: string[] = [];
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return {
    text: () => written.join(''),
    restore: () => {
      out.mockRestore();
      err.mockRestore();
    },
  };
}

async function requestCodeIn(appEnv: string, nodeEnv: string) {
  // A plain lookup, so an APP_ENV exported by the shell running the tests cannot decide a case.
  const values: Record<string, string> = {
    APP_ENV: appEnv,
    NODE_ENV: nodeEnv,
    SMS_PROVIDER: 'log',
  };
  const config = { get: (key: string) => values[key] };
  const prisma = {
    phoneOtp: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'o',
        ...data,
      })),
    },
  };
  const channel = new SmsChannel(new NotificationProviderResolver(config as never));
  let body = '';
  const deliver = channel.deliver.bind(channel);
  jest.spyOn(channel, 'deliver').mockImplementation(async (msg: RenderedNotification) => {
    body = msg.body;
    return deliver(msg);
  });

  const streams = captureStreams();
  try {
    await new PhoneOtpService(prisma as never, channel, config as never).requestCode(PHONE);
  } finally {
    streams.restore();
  }
  const code = body.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error('the sign-in message carried no six-digit code');
  return { code, body, logged: streams.text() };
}

describe('sign-in codes and the log', () => {
  it('are printed on a developer machine (the control for every case below)', async () => {
    const { code, logged } = await requestCodeIn('LOCAL', 'development');
    expect(logged).toContain(code);
  });

  it.each([
    ['QA', 'production'],
    ['UAT', 'production'],
    ['PRODUCTION', 'production'],
  ])('never reach the log in %s', async (appEnv, nodeEnv) => {
    const { code, body, logged } = await requestCodeIn(appEnv, nodeEnv);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(body);
    expect(logged).not.toContain('9704464007');
    // The send is still visible as an event, with the number masked.
    expect(logged).toMatch(/content withheld/);
  });
});
