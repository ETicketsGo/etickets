import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  parseMarketProviderMap,
  routeNotificationProvider,
} from '@eticketsgo/shared-types';
import { NotificationPolicyResolver } from './notification-policy.resolver';
import {
  SMS_TRANSACTIONAL_ELIGIBLE,
  invalidSmsTransactionalTypes,
  smsTransactionalEnabled,
} from './sms-transactional';
import { dedupeKeyFor } from './dedupe-key';
import {
  DLT_SMS_TEMPLATES,
  PAYMENT_PENDING_SMS_KIND,
  dltVariablesFromPayload,
  renderDltSms,
} from '../templates/dlt-sms-templates';
import { NotificationService } from '../notification.service';

/**
 * SMS_TRANSACTIONAL_TYPES: the per-type switch that adds SMS for a verified Indian number.
 *
 * The payloads below are the shapes the real producers write (payments.service confirm,
 * refunds.service cancelFreeTickets, show-reminder.service, auth.service resetPassword), so a
 * producer that drops a field fails here, not at the carrier.
 */

const KNOWN = new Set(['email', 'sms', 'whatsapp', 'push', 'in_app']);
const known = (c: string) => KNOWN.has(c);

const IN_PHONE = '+919704464007';
const US_PHONE = '+14155550123';
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const STARTS = '2026-11-12T14:00:00.000Z'; // 07:30 PM in Kolkata

const PAYLOADS: Record<string, Record<string, unknown>> = {
  [NotificationType.BOOKING_CONFIRMED]: {
    bookingId: 'bk-1',
    reference: 'ETG-IND-2026-000042',
    eventTitle: 'Kantara Chapter 1',
    startsAt: STARTS,
    timeZone: 'Asia/Kolkata',
    seats: 'F7, F8',
    tickets: 2,
    currency: 'INR',
  },
  [NotificationType.BOOKING_CANCELLED]: {
    bookingId: 'bk-1',
    reference: 'ETG-IND-2026-000042',
    eventTitle: 'Kantara Chapter 1',
    startsAt: STARTS,
    timeZone: 'Asia/Kolkata',
    refundStatus: 'NOTHING_TO_REFUND',
  },
  [NotificationType.EVENT_REMINDER]: {
    bookingId: 'bk-1',
    reference: 'ETG-IND-2026-000042',
    eventName: 'Kantara Chapter 1',
    startsAt: STARTS,
    timeZone: 'Asia/Kolkata',
  },
  [NotificationType.PASSWORD_CHANGED]: {},
};

const EXPECTED_TEXT: Record<string, string> = {
  [NotificationType.BOOKING_CONFIRMED]:
    'ETicketsGo: Your booking ETG-IND-2026-000042 for Kantara Chapter 1 on 12 Nov 2026, 07:30 PM is confirmed. View your ticket in your account.',
  [NotificationType.BOOKING_CANCELLED]:
    'ETicketsGo: Your booking ETG-IND-2026-000042 for Kantara Chapter 1 has been cancelled. Check your account for refund details, if applicable.',
  [NotificationType.EVENT_REMINDER]:
    'ETicketsGo: Reminder! Your event Kantara Chapter 1 is scheduled for 12 Nov 2026, 07:30 PM. Please carry your ticket QR code for entry.',
  [NotificationType.PASSWORD_CHANGED]:
    'Your ETicketsGo password was changed successfully. If this was not you, contact our support team immediately.',
};

function build(
  opts: {
    types?: string;
    user?: { phone: string | null; phoneVerifiedAt: Date | null } | null;
    disabled?: string[];
  } = {},
) {
  const preferences = {
    resolveChannels: jest.fn(async (_u: string | null, _t: unknown, requested: string[]) =>
      requested.filter((c) => !(opts.disabled ?? []).includes(c)),
    ),
  };
  const consent = { mayReceiveMarketing: jest.fn(async () => false) };
  const config = new ConfigService(
    opts.types === undefined ? {} : { SMS_TRANSACTIONAL_TYPES: opts.types },
  );
  const user = opts.user === undefined ? { phone: IN_PHONE, phoneVerifiedAt: VERIFIED } : opts.user;
  const prisma = {
    user: { findUnique: jest.fn(async () => (user ? { locale: null, ...user } : null)) },
  };
  const resolver = new NotificationPolicyResolver(
    preferences as never,
    consent as never,
    config,
    prisma as never,
  );
  return { resolver, prisma, preferences };
}

const RECIPIENT = { userId: 'u-1', email: 'buyer@example.test' };

async function channelsFor(
  type: NotificationType,
  opts: Parameters<typeof build>[0] = {},
  extra: {
    requested?: string[];
    recipient?: typeof RECIPIENT | { userId: null; email: string };
  } = {},
) {
  const { resolver } = build(opts);
  const out = await resolver.resolve({
    type,
    recipient: extra.recipient ?? RECIPIENT,
    requested: extra.requested,
    known,
    payload: PAYLOADS[type] ?? {},
  });
  return out;
}

const ELIGIBLE = SMS_TRANSACTIONAL_ELIGIBLE.map((t) => [t] as const);

describe('SMS_TRANSACTIONAL_TYPES: the switch', () => {
  it('names exactly the four types that have a real trigger and an approved template', () => {
    expect([...SMS_TRANSACTIONAL_ELIGIBLE].sort()).toEqual(
      [
        NotificationType.BOOKING_CANCELLED,
        NotificationType.BOOKING_CONFIRMED,
        NotificationType.EVENT_REMINDER,
        NotificationType.PASSWORD_CHANGED,
      ].sort(),
    );
  });

  it('refuses the password reset (email link, no code), payment pending and unknown names', () => {
    expect(
      invalidSmsTransactionalTypes(
        `BOOKING_CONFIRMED,PASSWORD_RESET_REQUESTED,${PAYMENT_PENDING_SMS_KIND},ACCOUNT_SECURITY`,
      ),
    ).toEqual(['PASSWORD_RESET_REQUESTED', 'PAYMENT_PENDING', 'ACCOUNT_SECURITY']);
    expect(
      smsTransactionalEnabled(
        NotificationType.PASSWORD_RESET_REQUESTED,
        'PASSWORD_RESET_REQUESTED',
      ),
    ).toBe(false);
  });
});

describe.each(ELIGIBLE)('%s', (type) => {
  it('flag absent: no sms channel, the phone is not even read', async () => {
    const { resolver, prisma } = build();
    const out = await resolver.resolve({
      type,
      recipient: RECIPIENT,
      known,
      payload: PAYLOADS[type],
    });
    expect(out.channels).not.toContain('sms');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('flag names another type: no sms channel', async () => {
    const other = SMS_TRANSACTIONAL_ELIGIBLE.find((t) => t !== type)!;
    expect((await channelsFor(type, { types: other })).channels).not.toContain('sms');
  });

  it('flag on + verified Indian phone: sms added, with the exact registered wording', async () => {
    const out = await channelsFor(type, { types: type });
    expect(out.channels).toContain('sms');
    const template = DLT_SMS_TEMPLATES[type as keyof typeof DLT_SMS_TEMPLATES];
    const vars = dltVariablesFromPayload(template, PAYLOADS[type]);
    expect('values' in vars).toBe(true);
    if ('values' in vars) {
      expect(renderDltSms(template, vars.values)).toBe(EXPECTED_TEXT[type]);
      expect((template.msg91Variables ?? template.variables).length).toBe(vars.values.length);
    }
  });

  it('flag on + US phone: no sms (North America keeps its channels)', async () => {
    const out = await channelsFor(type, {
      types: type,
      user: { phone: US_PHONE, phoneVerifiedAt: VERIFIED },
    });
    expect(out.channels).not.toContain('sms');
    expect(out.removed).toContainEqual({ channel: 'sms', reason: 'market not enabled' });
  });

  it('flag on + unverified Indian phone: no sms', async () => {
    const out = await channelsFor(type, {
      types: type,
      user: { phone: IN_PHONE, phoneVerifiedAt: null },
    });
    expect(out.channels).not.toContain('sms');
  });

  it('flag on + no account (guest): no sms', async () => {
    const out = await channelsFor(
      type,
      { types: type },
      { recipient: { userId: null, email: 'guest@example.test' } },
    );
    expect(out.channels).not.toContain('sms');
  });

  it('flag on + the customer turned sms off for this type: no sms (not guaranteed)', async () => {
    const out = await channelsFor(type, { types: type, disabled: ['sms'] });
    expect(out.channels).not.toContain('sms');
  });

  it('flag on + caller asked for channels without sms: no sms', async () => {
    const out = await channelsFor(type, { types: type }, { requested: ['email', 'in_app'] });
    expect(out.channels).not.toContain('sms');
  });

  it('never logs or returns the phone number in a reason', async () => {
    const out = await channelsFor(type, {
      types: type,
      user: { phone: US_PHONE, phoneVerifiedAt: VERIFIED },
    });
    expect(JSON.stringify(out)).not.toContain(US_PHONE);
  });
});

describe('a variable the producer did not supply', () => {
  it('booking confirmed with no show time: no sms row (the channel would refuse it)', async () => {
    const { resolver } = build({ types: NotificationType.BOOKING_CONFIRMED });
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CONFIRMED,
      recipient: RECIPIENT,
      known,
      payload: { ...PAYLOADS[NotificationType.BOOKING_CONFIRMED], startsAt: '' },
    });
    expect(out.channels).not.toContain('sms');
    expect(out.removed).toContainEqual({ channel: 'sms', reason: 'missing when' });
  });
});

describe('the US route is unchanged', () => {
  it('a +1 number still routes to twilio and +91 to msg91', () => {
    const marketProviders = parseMarketProviderMap('IN=msg91,US=twilio,CA=twilio');
    expect(
      routeNotificationProvider({ marketProviders, defaultProvider: 'log', destination: US_PHONE }),
    ).toMatchObject({ ok: true, provider: 'twilio' });
    expect(
      routeNotificationProvider({ marketProviders, defaultProvider: 'log', destination: IN_PHONE }),
    ).toMatchObject({ ok: true, provider: 'msg91', market: 'IN' });
  });
});

describe('no duplicate SMS on retry or redelivery', () => {
  it.each([NotificationType.BOOKING_CONFIRMED, NotificationType.BOOKING_CANCELLED])(
    '%s: the sms row has one dedupe key per booking, distinct from the email row',
    (type) => {
      const ctx = { type, recipientRef: 'u-1', payload: PAYLOADS[type] };
      const sms = dedupeKeyFor({ ...ctx, channel: 'sms' });
      expect(sms).toBeTruthy();
      expect(dedupeKeyFor({ ...ctx, channel: 'sms' })).toBe(sms);
      expect(dedupeKeyFor({ ...ctx, channel: 'email' })).not.toBe(sms);
    },
  );

  it('event reminder: keyed on booking + show start, so a second sweep tick is the same row', () => {
    const intent = `reminder:bk-1:${STARTS}`;
    const ctx = {
      type: NotificationType.EVENT_REMINDER,
      channel: 'sms' as const,
      recipientRef: 'u-1',
      payload: PAYLOADS[NotificationType.EVENT_REMINDER],
    };
    expect(dedupeKeyFor({ ...ctx, explicitIntent: intent })).toBe(
      dedupeKeyFor({ ...ctx, explicitIntent: intent }),
    );
  });

  it('through NotificationService: the second confirmation for a booking writes no new sms row', async () => {
    const { resolver, prisma } = build({ types: NotificationType.BOOKING_CONFIRMED });
    const written = new Set<string>();
    const createMany = jest.fn(
      async ({
        data,
      }: {
        data: { dedupeKey: string; channel: string; payload: Record<string, unknown> }[];
      }) => {
        const fresh = data.filter((d) => !written.has(d.dedupeKey));
        fresh.forEach((d) => written.add(d.dedupeKey));
        return { count: fresh.length };
      },
    );
    const db = {
      ...prisma,
      notification: {
        createMany,
        create: jest.fn(),
        findFirst: jest.fn(async () => ({ id: 'n-1' })),
      },
    };
    const service = new NotificationService(
      db as never,
      { render: jest.fn(() => ({ subject: 'S', body: 'B' })) } as never,
      { resolveChannels: jest.fn(async (_u: unknown, _t: unknown, r: string[]) => r) } as never,
      { has: known, resolve: jest.fn() } as never,
      { mayReceiveMarketing: jest.fn(async () => false) } as never,
      undefined,
      undefined,
      undefined,
      resolver,
    );
    const input = {
      type: NotificationType.BOOKING_CONFIRMED,
      userId: 'u-1',
      toEmail: 'buyer@example.test',
      payload: PAYLOADS[NotificationType.BOOKING_CONFIRMED],
    };
    await service.sendCritical(db as never, input);
    const firstSms = createMany.mock.calls
      .map((c) => c[0].data[0])
      .filter((d) => d.channel === 'sms');
    expect(firstSms).toHaveLength(1);
    expect(firstSms[0].payload).toMatchObject({
      reference: 'ETG-IND-2026-000042',
      eventTitle: 'Kantara Chapter 1',
      startsAt: STARTS,
      timeZone: 'Asia/Kolkata',
    });

    const before = written.size;
    await service.sendCritical(db as never, input);
    expect(written.size).toBe(before);
  });
});
