import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationPolicyResolver } from './notification-policy.resolver';
import {
  SMS_CONSENT_REQUIRED_MARKETS,
  SMS_SKIP_REASON,
  smsConsentRefusal,
  smsConsentRequiredFor,
  type SmsConsentState,
} from './sms-consent';
import { NotificationService } from '../notification.service';

/**
 * Transactional SMS consent: a +1 number is texted about a booking only when its owner ticked
 * the text-message box (`sms:transactional`), and India is unchanged.
 *
 * The rule is checked twice: when the row is written (the resolver) and when the worker is
 * about to call the provider (the sweep), because consent can be withdrawn and a STOP can
 * arrive in between. Neither check may ever cost the booking its confirmation.
 */

const KNOWN = new Set(['email', 'sms', 'whatsapp', 'push', 'in_app']);
const known = (c: string) => KNOWN.has(c);
const IN_PHONE = '+919704464007';
const US_PHONE = '+14155550123';
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const STARTS = '2026-11-12T14:00:00.000Z';

const US_CONFIRMED = {
  bookingId: 'bk-us-1',
  reference: 'ETG-USA-2026-000042',
  eventTitle: 'Hamilton',
  startsAt: STARTS,
  timeZone: 'America/New_York',
  tickets: 2,
  currency: 'USD',
};
const IN_CONFIRMED = {
  bookingId: 'bk-in-1',
  reference: 'ETG-IND-2026-000042',
  eventTitle: 'Kantara Chapter 1',
  startsAt: STARTS,
  timeZone: 'Asia/Kolkata',
  seats: 'F7, F8',
  tickets: 2,
  currency: 'INR',
};

/** The SMS switch on for confirmations, and every market with an SMS path enabled. */
const ENV = {
  SMS_TRANSACTIONAL_TYPES: NotificationType.BOOKING_CONFIRMED,
  SMS_TRANSACTIONAL_MARKETS: 'IN,US,CA',
};

function consentWith(
  state: SmsConsentState | Error,
  marketingSms = false,
): {
  mayReceiveMarketing: jest.Mock;
  smsTransactionalConsent: jest.Mock;
} {
  return {
    mayReceiveMarketing: jest.fn(async (_s: unknown, channel: string) =>
      channel === 'sms' ? marketingSms : false,
    ),
    smsTransactionalConsent: jest.fn(async () => {
      if (state instanceof Error) throw state;
      return state;
    }),
  };
}

function build(opts: {
  phone?: string;
  consent?: object;
  suppressed?: boolean;
  env?: Record<string, string>;
}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        phone: opts.phone ?? US_PHONE,
        phoneVerifiedAt: VERIFIED,
        locale: null,
      })),
    },
  };
  const suppression = { isSuppressed: jest.fn(async () => opts.suppressed === true) };
  const resolver = new NotificationPolicyResolver(
    { resolveChannels: jest.fn(async (_u: unknown, _t: unknown, r: string[]) => r) } as never,
    (opts.consent ?? consentWith('granted')) as never,
    new ConfigService(opts.env ?? ENV),
    prisma as never,
    suppression as never,
  );
  return { resolver, prisma, suppression };
}

const RECIPIENT = { userId: 'u-1', email: 'buyer@example.test' };

async function resolveFor(
  opts: Parameters<typeof build>[0],
  type = NotificationType.BOOKING_CONFIRMED,
  payload: Record<string, unknown> = opts.phone === IN_PHONE ? IN_CONFIRMED : US_CONFIRMED,
) {
  return build(opts).resolver.resolve({ type, recipient: RECIPIENT, known, payload });
}

describe('the per-market rule', () => {
  it('the US and Canada need an opt-in; India does not', () => {
    expect([...SMS_CONSENT_REQUIRED_MARKETS].sort()).toEqual(['CA', 'US']);
    expect(smsConsentRequiredFor(US_PHONE)).toBe(true);
    expect(smsConsentRequiredFor('+14165550123')).toBe(true);
    expect(smsConsentRequiredFor(IN_PHONE)).toBe(false);
  });

  it('a number it cannot place needs an opt-in (fail closed)', () => {
    expect(smsConsentRequiredFor('4155550123')).toBe(true);
  });

  it('India never reads the consent record at all', async () => {
    const readConsent = jest.fn(async () => 'none' as const);
    await expect(
      smsConsentRefusal({ phone: IN_PHONE, hasSubject: true, readConsent }),
    ).resolves.toBeNull();
    expect(readConsent).not.toHaveBeenCalled();
  });

  it.each([
    ['granted', null],
    ['none', SMS_SKIP_REASON.NO_CONSENT],
    ['withdrawn', SMS_SKIP_REASON.CONSENT_WITHDRAWN],
  ] as const)('+1 with consent %s -> %s', async (state, expected) => {
    await expect(
      smsConsentRefusal({ phone: US_PHONE, hasSubject: true, readConsent: async () => state }),
    ).resolves.toBe(expected);
  });

  it('+1 with nobody to hold the consent: no sms consent', async () => {
    const readConsent = jest.fn(async () => 'granted' as const);
    await expect(
      smsConsentRefusal({ phone: US_PHONE, hasSubject: false, readConsent }),
    ).resolves.toBe(SMS_SKIP_REASON.NO_CONSENT);
    expect(readConsent).not.toHaveBeenCalled();
  });

  it('a lookup that fails is not consent: the error reaches the caller', async () => {
    await expect(
      smsConsentRefusal({
        phone: US_PHONE,
        hasSubject: true,
        readConsent: async () => {
          throw new Error('db down');
        },
      }),
    ).rejects.toThrow('db down');
  });
});

describe('at enqueue: the resolver', () => {
  it('US with sms:transactional consent: sms', async () => {
    const out = await resolveFor({});
    expect(out.channels).toContain('sms');
  });

  it('US without consent: no sms, reason "no sms consent", email kept', async () => {
    const out = await resolveFor({ consent: consentWith('none') });
    expect(out.channels).not.toContain('sms');
    expect(out.channels).toContain('email');
    expect(out.removed).toContainEqual({ channel: 'sms', reason: 'no sms consent' });
  });

  it('US with consent withdrawn: no sms, reason "sms consent withdrawn"', async () => {
    const out = await resolveFor({ consent: consentWith('withdrawn') });
    expect(out.channels).not.toContain('sms');
    expect(out.removed).toContainEqual({ channel: 'sms', reason: 'sms consent withdrawn' });
  });

  it('marketing SMS consent alone does not authorise a transactional text', async () => {
    const consent = consentWith('none', true);
    const out = await resolveFor({ consent });
    expect(out.channels).not.toContain('sms');
    expect(out.removed).toContainEqual({ channel: 'sms', reason: 'no sms consent' });
    // The transactional decision is made from the transactional scope, never from `sms`.
    expect(consent.mayReceiveMarketing).not.toHaveBeenCalledWith(expect.anything(), 'sms');
  });

  it('US number on the STOP list: no sms, reason "destination suppressed"', async () => {
    const out = await resolveFor({ suppressed: true });
    expect(out.channels).not.toContain('sms');
    expect(out.removed).toContainEqual({ channel: 'sms', reason: 'destination suppressed' });
  });

  it('a consent lookup that throws costs the text, never the message', async () => {
    const out = await resolveFor({ consent: consentWith(new Error('db down')) });
    expect(out.channels).not.toContain('sms');
    expect(out.channels).toContain('email');
    expect(out.removed).toContainEqual({
      channel: 'sms',
      reason: 'sms consent could not be checked',
    });
  });

  it('India, verified phone, no consent record: sms exactly as before', async () => {
    // No smsTransactionalConsent on the mock at all: India must never ask.
    const consent = { mayReceiveMarketing: jest.fn(async () => false) };
    const out = await resolveFor({ phone: IN_PHONE, consent });
    expect(out.channels).toContain('sms');
    expect(out.removed.filter((r) => r.channel === 'sms')).toEqual([]);
  });

  it('the SHOW_CANCELLED fallback SMS to a +1 number needs the same consent', async () => {
    const { resolver } = build({ consent: consentWith('none') });
    const out = await resolver.resolve({
      type: NotificationType.SHOW_CANCELLED,
      recipient: RECIPIENT,
      known,
      allowDeferred: true,
      payload: { bookingId: 'bk-us-1' },
    });
    expect(out.channels).not.toContain('sms');
    expect(out.removed).toContainEqual({ channel: 'sms', reason: 'no sms consent' });
  });
});

describe('at enqueue: the booking confirmation is never at the mercy of the SMS', () => {
  function serviceWith(consent: object) {
    const { resolver, prisma } = build({ consent });
    const createMany = jest.fn(async (_: { data: Record<string, unknown>[] }) => ({ count: 1 }));
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
      consent as never,
      undefined,
      undefined,
      undefined,
      resolver,
    );
    const rows = () => createMany.mock.calls.map((c) => c[0].data[0]);
    return { service, db, rows };
  }

  const input = {
    type: NotificationType.BOOKING_CONFIRMED,
    userId: 'u-1',
    toEmail: 'buyer@example.test',
    payload: US_CONFIRMED,
  };

  it('no consent: email is queued, and the SMS is a SKIPPED row with the reason', async () => {
    const { service, db, rows } = serviceWith(consentWith('none'));
    await expect(service.sendCritical(db as never, input)).resolves.toBeUndefined();
    const email = rows().find((r) => r.channel === 'email');
    expect(email).toMatchObject({ status: 'PENDING' });
    const sms = rows().filter((r) => r.channel === 'sms');
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({
      status: 'SKIPPED',
      lastError: 'not_sent: no sms consent',
      bookingId: 'bk-us-1',
      toEmail: null,
    });
    // The row carries the same dedupe key a real SMS row would, so a redelivery writes no text.
    expect(sms[0].dedupeKey).toBeTruthy();
  });

  it('the consent store is down: the confirmation still commits, the SMS is skipped', async () => {
    const { service, db, rows } = serviceWith(consentWith(new Error('db down')));
    await expect(service.sendCritical(db as never, input)).resolves.toBeUndefined();
    expect(rows().find((r) => r.channel === 'email')).toMatchObject({ status: 'PENDING' });
    expect(rows().find((r) => r.channel === 'sms')).toMatchObject({
      status: 'SKIPPED',
      lastError: 'not_sent: sms consent could not be checked',
    });
  });

  it('with consent: one PENDING sms row', async () => {
    const { service, db, rows } = serviceWith(consentWith('granted'));
    await service.sendCritical(db as never, input);
    const sms = rows().filter((r) => r.channel === 'sms');
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ status: 'PENDING' });
  });
});

describe('at send: the sweep checks again, inside the dispatch lock', () => {
  function sweep(opts: {
    phone: string;
    consent: object;
    suppressed?: boolean;
    channel?: 'sms' | 'email';
    deliver?: jest.Mock;
    rows?: Record<string, unknown>[];
  }) {
    const row = {
      id: 'n-sms',
      type: NotificationType.BOOKING_CONFIRMED,
      channel: opts.channel ?? 'sms',
      locale: 'en',
      userId: 'u-1',
      toEmail: 'buyer@example.test',
      payload: US_CONFIRMED,
      status: 'PENDING',
      attempts: 0,
      sendReason: null,
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]) }),
      ),
      notification: {
        findMany: jest.fn().mockResolvedValue(opts.rows ?? [row]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findUnique: jest.fn(async () => ({ phone: opts.phone })) },
    };
    const deliver = opts.deliver ?? jest.fn().mockResolvedValue({ provider: 'twilio' });
    const suppression = { isSuppressed: jest.fn(async () => opts.suppressed === true) };
    const service = new NotificationService(
      prisma as never,
      { render: jest.fn().mockReturnValue({ subject: 'S', body: 'B' }) } as never,
      {} as never,
      {
        resolve: jest.fn((c: string) => ({ key: c, deliver: (m: unknown) => deliver(c, m) })),
      } as never,
      opts.consent as never,
      undefined,
      undefined,
      suppression as never,
    );
    const updates = () =>
      prisma.notification.updateMany.mock.calls.map(
        (c) => c[0] as { where: { id: string }; data: Record<string, unknown> },
      );
    return { service, deliver, updates };
  }

  it('consent withdrawn after enqueue: not sent, SKIPPED with the reason, not retried', async () => {
    const { service, deliver, updates } = sweep({
      phone: US_PHONE,
      consent: consentWith('withdrawn'),
    });
    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));
    expect(deliver).not.toHaveBeenCalled();
    expect(updates()).toEqual([
      {
        where: { id: 'n-sms', status: { in: ['PENDING', 'SCHEDULED'] } },
        data: { status: 'SKIPPED', lastError: 'not_sent: sms consent withdrawn' },
      },
    ]);
  });

  it('STOP after enqueue: not sent, SKIPPED as suppressed, consent not even read', async () => {
    const consent = consentWith('granted');
    const { service, deliver, updates } = sweep({ phone: US_PHONE, consent, suppressed: true });
    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));
    expect(deliver).not.toHaveBeenCalled();
    expect(updates()[0].data).toMatchObject({
      status: 'SKIPPED',
      lastError: 'destination_suppressed',
    });
    expect(consent.smsTransactionalConsent).not.toHaveBeenCalled();
  });

  it('consent still granted: sent', async () => {
    const { service, deliver } = sweep({ phone: US_PHONE, consent: consentWith('granted') });
    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a consent lookup that throws is retried later, never sent and never read as yes', async () => {
    const { service, deliver, updates } = sweep({
      phone: US_PHONE,
      consent: consentWith(new Error('db down')),
    });
    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));
    expect(deliver).not.toHaveBeenCalled();
    expect(updates()[0].data).toMatchObject({ attempts: 1, status: 'PENDING' });
  });

  it('India: sent with no consent record, and no consent lookup', async () => {
    const consent = { mayReceiveMarketing: jest.fn(async () => false) };
    const { service, deliver } = sweep({ phone: IN_PHONE, consent });
    await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a refused or failing SMS does not stop the email for the same booking', async () => {
    const base = {
      type: NotificationType.BOOKING_CONFIRMED,
      locale: 'en',
      userId: 'u-1',
      toEmail: 'buyer@example.test',
      payload: US_CONFIRMED,
      status: 'PENDING',
      attempts: 0,
      sendReason: null,
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
    };
    const deliver = jest.fn(async (channel: string) => {
      if (channel === 'sms') throw new Error('twilio is down');
      return { provider: 'ses', providerMessageId: 'ses-1' };
    });
    const { service, updates } = sweep({
      phone: US_PHONE,
      consent: consentWith('granted'),
      deliver,
      rows: [
        { ...base, id: 'n-sms', channel: 'sms' },
        { ...base, id: 'n-email', channel: 'email' },
      ],
    });
    await expect(service.dispatchDue(new Date('2026-06-01T00:00:00Z'))).resolves.toMatchObject({
      sent: 1,
      retried: 1,
    });
    const email = updates().find((u) => u.where.id === 'n-email');
    expect(email?.data).toMatchObject({ status: 'SENT' });
  });
});
