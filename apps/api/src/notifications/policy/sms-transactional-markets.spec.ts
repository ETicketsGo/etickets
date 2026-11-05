import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationPolicyResolver } from './notification-policy.resolver';
import {
  SMS_TRANSACTIONAL_ELIGIBLE,
  invalidSmsTransactionalMarkets,
  parseSmsTransactionalMarkets,
  smsTransactionalRefusal,
} from './sms-transactional';

/**
 * SMS_TRANSACTIONAL_MARKETS: which countries' numbers the per-type switch may text.
 *
 * India is the default. The US and Canada go through the existing Twilio path (no DLT), and
 * only when this setting names them, so +1 stays off until it is certified.
 */

const KNOWN = new Set(['email', 'sms', 'whatsapp', 'push', 'in_app']);
const known = (c: string) => KNOWN.has(c);
const IN_PHONE = '+919704464007';
const US_PHONE = '+14155550123';
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const STARTS = '2026-11-12T14:00:00.000Z';

const PAYLOADS: Record<string, Record<string, unknown>> = {
  [NotificationType.BOOKING_CONFIRMED]: {
    bookingId: 'bk-1',
    reference: 'ETG-USA-2026-000042',
    eventTitle: 'Hamilton',
    startsAt: STARTS,
    timeZone: 'America/New_York',
    tickets: 2,
    currency: 'USD',
  },
  [NotificationType.BOOKING_CANCELLED]: {
    bookingId: 'bk-1',
    reference: 'ETG-USA-2026-000042',
    eventTitle: 'Hamilton',
    startsAt: STARTS,
    timeZone: 'America/New_York',
  },
  [NotificationType.EVENT_REMINDER]: {
    bookingId: 'bk-1',
    reference: 'ETG-USA-2026-000042',
    eventName: 'Hamilton',
    startsAt: STARTS,
    timeZone: 'America/New_York',
  },
  [NotificationType.PASSWORD_CHANGED]: {},
};

function resolverWith(env: Record<string, string>, phone: string) {
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ phone, phoneVerifiedAt: VERIFIED })) },
  };
  return new NotificationPolicyResolver(
    { resolveChannels: jest.fn(async (_u: unknown, _t: unknown, r: string[]) => r) } as never,
    { mayReceiveMarketing: jest.fn(async () => false) } as never,
    new ConfigService(env),
    prisma as never,
  );
}

async function resolve(
  type: NotificationType,
  env: Record<string, string>,
  phone: string,
  payload = PAYLOADS[type],
) {
  return resolverWith(env, phone).resolve({
    type,
    recipient: { userId: 'u-1', email: 'buyer@example.test' },
    known,
    payload,
  });
}

describe('SMS_TRANSACTIONAL_MARKETS: parsing and boot validation', () => {
  it('defaults to India alone when unset or blank', () => {
    expect(parseSmsTransactionalMarkets(undefined)).toEqual(['IN']);
    expect(parseSmsTransactionalMarkets('')).toEqual(['IN']);
    expect(parseSmsTransactionalMarkets('  ')).toEqual(['IN']);
  });

  it('reads a comma list, case and spaces ignored', () => {
    expect(parseSmsTransactionalMarkets(' in, us ,ca')).toEqual(['IN', 'US', 'CA']);
  });

  it('refuses a market it has no SMS path for', () => {
    expect(invalidSmsTransactionalMarkets('IN,US,GB,XX')).toEqual(['GB', 'XX']);
    expect(invalidSmsTransactionalMarkets(undefined)).toEqual([]);
    expect(invalidSmsTransactionalMarkets('IN,US,CA')).toEqual([]);
  });
});

describe.each(SMS_TRANSACTIONAL_ELIGIBLE.map((t) => [t] as const))('%s', (type) => {
  it('+1 number, markets unset (default IN): no sms', async () => {
    const out = await resolve(type, { SMS_TRANSACTIONAL_TYPES: type }, US_PHONE);
    expect(out.channels).not.toContain('sms');
    expect(out.removed).toContainEqual({ channel: 'sms', reason: 'market not enabled' });
  });

  it('+1 number, markets US and CA: sms added (Twilio path, no DLT check)', async () => {
    const out = await resolve(
      type,
      { SMS_TRANSACTIONAL_TYPES: type, SMS_TRANSACTIONAL_MARKETS: 'IN,US,CA' },
      US_PHONE,
    );
    expect(out.channels).toContain('sms');
  });

  it('+1 number, only US named: no sms (a +1 number may be Canadian)', async () => {
    const out = await resolve(
      type,
      { SMS_TRANSACTIONAL_TYPES: type, SMS_TRANSACTIONAL_MARKETS: 'IN,US' },
      US_PHONE,
    );
    expect(out.channels).not.toContain('sms');
  });

  it('+91 number, markets US,CA only: no sms (India switched off)', async () => {
    const out = await resolve(
      type,
      { SMS_TRANSACTIONAL_TYPES: type, SMS_TRANSACTIONAL_MARKETS: 'US,CA' },
      IN_PHONE,
      { ...PAYLOADS[type], reference: 'ETG-IND-2026-000042', eventTitle: 'Kantara' },
    );
    expect(out.channels).not.toContain('sms');
  });

  it('types switch empty: +1 gets nothing even with the market on', async () => {
    const out = await resolve(type, { SMS_TRANSACTIONAL_MARKETS: 'IN,US,CA' }, US_PHONE);
    expect(out.channels).not.toContain('sms');
  });
});

describe('+1 numbers: the template contract instead of DLT', () => {
  it('a field the rendered message needs is missing: no sms row', () => {
    expect(
      smsTransactionalRefusal({
        type: NotificationType.BOOKING_CONFIRMED,
        phone: US_PHONE,
        phoneVerifiedAt: VERIFIED,
        payload: { bookingId: 'bk-1' },
        markets: ['US', 'CA'],
      }),
    ).toMatch(/^missing /);
  });

  it('an unverified +1 number: no sms', () => {
    expect(
      smsTransactionalRefusal({
        type: NotificationType.BOOKING_CANCELLED,
        phone: US_PHONE,
        phoneVerifiedAt: null,
        payload: PAYLOADS[NotificationType.BOOKING_CANCELLED],
        markets: ['US', 'CA'],
      }),
    ).toBe('phone not verified');
  });
});
