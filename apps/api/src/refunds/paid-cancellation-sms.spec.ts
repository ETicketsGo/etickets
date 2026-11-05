import { ConfigService } from '@nestjs/config';
import {
  ExperienceType,
  NotificationType,
  RefundStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { RefundsService } from './refunds.service';
import { MetricsService } from '../metrics/metrics.service';
import { NotificationPolicyResolver } from '../notifications/policy/notification-policy.resolver';
import { dedupeKeyFor } from '../notifications/policy/dedupe-key';
import {
  DLT_SMS_TEMPLATES,
  dltVariablesFromPayload,
  renderDltSms,
} from '../notifications/templates/dlt-sms-templates';

/**
 * A PAID booking that ends because its refund was approved: one BOOKING_CANCELLED, SMS only.
 *
 * The buyer already gets REFUND_COMPLETED by email, so this adds no email and no inbox card.
 * It asks for SMS alone, and the per-type switch (SMS_TRANSACTIONAL_TYPES) decides whether
 * that becomes a row. Switched off - the default - nothing is written.
 */

const ADMIN = { id: 'admin-1', email: 'a@t.test', fullName: 'A', roles: ['ADMIN'] } as never;
const STARTS = new Date('2026-11-12T14:00:00.000Z');

function setup(
  opts: {
    tickets?: { id: string; status: string }[];
    refundTicketIds?: string[];
    providerStatus?: 'COMPLETED' | 'PROCESSING' | 'FAILED';
    sessionStatus?: string;
    eventStatus?: string;
  } = {},
) {
  const refund = {
    id: 'rf-1',
    bookingId: 'b1',
    organizationId: 'org-1',
    amountMinor: 50_000,
    reason: 'cannot make it',
    status: RefundStatus.REQUESTED,
    ticketIds: opts.refundTicketIds ?? ['tk1'],
    createdAt: new Date('2026-10-30T00:00:00Z'),
  };
  const tickets = (opts.tickets ?? [{ id: 'tk1', status: TicketStatus.ACTIVE }]).map((t) => ({
    ...t,
    ticketTypeId: 't1',
    seatId: null,
  }));
  const booking = {
    id: 'b1',
    userId: 'u1',
    buyerEmail: 'buyer@t.test',
    reference: 'ETG-IND-2026-000042',
    currency: 'INR',
    eventSessionId: 'sess-1',
    seatBased: false,
    totalMinor: 50_000,
    paymentMethod: 'ONLINE',
    tickets,
    items: [],
    event: {
      experienceType: ExperienceType.EVENT,
      title: 'Kantara Chapter 1',
      status: opts.eventStatus ?? 'PUBLISHED',
      venue: { timezone: 'Asia/Kolkata', country: 'IN' },
    },
    eventSession: { startsAt: STARTS, status: opts.sessionStatus ?? 'SCHEDULED', screen: null },
  };
  const tx = {
    ticket: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    booking: { update: jest.fn().mockResolvedValue({}) },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    refund: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ providerCallCount: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    refundProviderAttempt: { create: jest.fn().mockResolvedValue({ id: 'att-1', attemptNo: 1 }) },
  };
  const prisma = {
    adminGrant: { findMany: jest.fn().mockResolvedValue([{ permission: 'REFUND_APPROVE' }]) },
    refund: {
      findUnique: jest.fn().mockResolvedValue(refund),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    payment: { findUnique: jest.fn().mockResolvedValue({ providerRef: 'pay_1' }) },
    refundProviderAttempt: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = {
    send: jest.fn(),
    sendCritical: jest.fn().mockResolvedValue(undefined),
  };
  const service = new RefundsService(
    prisma as never,
    {
      refundPayment: jest.fn().mockResolvedValue({
        providerRef: 'rfnd_1',
        status: opts.providerStatus ?? 'COMPLETED',
      }),
    } as never,
    { forSeating: jest.fn().mockReturnValue({ refund: jest.fn() }) } as never,
    {
      isPlatformAdmin: () => false,
      assertMember: async () => undefined,
      recordPlatformRefusal: jest.fn(),
    } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    notifications as never,
    new MetricsService(),
    { issueCreditNote: jest.fn() } as never,
  );
  const cancelled = () =>
    notifications.sendCritical.mock.calls.filter(
      (c) => c[1].type === NotificationType.BOOKING_CANCELLED,
    );
  return { service, tx, cancelled, notifications };
}

describe('a paid booking whose refund is approved and ends it', () => {
  it('writes one BOOKING_CANCELLED, SMS only, in the transaction that ends the booking', async () => {
    const { service, tx, cancelled } = setup();
    await service.process(ADMIN, 'rf-1', 'APPROVE');

    const told = cancelled();
    expect(told).toHaveLength(1);
    expect(told[0][0]).toBe(tx);
    expect(told[0][1]).toMatchObject({
      userId: 'u1',
      toEmail: 'buyer@t.test',
      bookingId: 'b1',
      channels: ['sms'],
      payload: {
        bookingId: 'b1',
        reference: 'ETG-IND-2026-000042',
        eventTitle: 'Kantara Chapter 1',
        startsAt: STARTS.toISOString(),
        timeZone: 'Asia/Kolkata',
      },
    });
    // Never claims anything about the money: no refund stage, no amount, no "nothing to refund".
    const payload = told[0][1].payload as Record<string, unknown>;
    expect(payload.refundStatus).toBeUndefined();
    expect(payload.stage).toBeUndefined();
    expect(payload.amountMinor).toBeUndefined();
  });

  it('is still written when the provider accepted but has not paid yet (PROCESSING)', async () => {
    const { service, cancelled } = setup({ providerStatus: 'PROCESSING' });
    await service.process(ADMIN, 'rf-1', 'APPROVE');
    expect(cancelled()).toHaveLength(1);
  });

  it('is not written when the provider refused the refund (nothing was cancelled)', async () => {
    const { service, cancelled } = setup({ providerStatus: 'FAILED' });
    await expect(service.process(ADMIN, 'rf-1', 'APPROVE')).rejects.toBeDefined();
    expect(cancelled()).toHaveLength(0);
  });

  it('is not written for a partial refund: the booking lives on', async () => {
    const { service, cancelled } = setup({
      tickets: [
        { id: 'tk1', status: TicketStatus.ACTIVE },
        { id: 'tk2', status: TicketStatus.ACTIVE },
      ],
      refundTicketIds: ['tk1'],
    });
    await service.process(ADMIN, 'rf-1', 'APPROVE');
    expect(cancelled()).toHaveLength(0);
  });

  it.each([
    ['the show was cancelled', { sessionStatus: 'CANCELLED' }],
    ['the event was cancelled', { eventStatus: 'CANCELLED' }],
  ])('is not written when %s: SHOW_CANCELLED tells them, once', async (_why, o) => {
    const { service, cancelled, notifications } = setup(o);
    await service.process(ADMIN, 'rf-1', 'APPROVE');
    expect(cancelled()).toHaveLength(0);
    // The refund notice is untouched.
    expect(notifications.sendCritical.mock.calls.map((c) => c[1].type)).toContain(
      NotificationType.REFUND_COMPLETED,
    );
  });
});

describe('what the SMS-only request becomes in the policy', () => {
  const PAYLOAD = {
    bookingId: 'b1',
    reference: 'ETG-IND-2026-000042',
    eventTitle: 'Kantara Chapter 1',
    startsAt: STARTS.toISOString(),
    timeZone: 'Asia/Kolkata',
  };
  const known = (c: string) => ['email', 'sms', 'whatsapp', 'push', 'in_app'].includes(c);
  const resolverWith = (env: Record<string, string>) =>
    new NotificationPolicyResolver(
      { resolveChannels: jest.fn(async (_u: unknown, _t: unknown, r: string[]) => r) } as never,
      { mayReceiveMarketing: jest.fn(async () => false) } as never,
      new ConfigService(env),
      {
        user: {
          findUnique: jest.fn(async () => ({
            phone: '+919704464007',
            phoneVerifiedAt: new Date('2026-10-01T00:00:00Z'),
          })),
        },
      } as never,
    );
  const resolve = (env: Record<string, string>) =>
    resolverWith(env).resolve({
      type: NotificationType.BOOKING_CANCELLED,
      recipient: { userId: 'u1', email: 'buyer@t.test' },
      requested: ['sms'],
      known,
      payload: PAYLOAD,
    });

  it('switch off (the default): no channel at all, so no row and no new email', async () => {
    expect((await resolve({})).channels).toEqual([]);
  });

  it('switch on, verified +91: SMS alone, never an extra email or inbox card', async () => {
    expect((await resolve({ SMS_TRANSACTIONAL_TYPES: 'BOOKING_CANCELLED' })).channels).toEqual([
      'sms',
    ]);
  });

  it('carries the approved wording, which promises no refund', () => {
    const template = DLT_SMS_TEMPLATES[NotificationType.BOOKING_CANCELLED];
    const vars = dltVariablesFromPayload(template, PAYLOAD);
    expect('values' in vars && renderDltSms(template, vars.values)).toBe(
      'ETicketsGo: Your booking ETG-IND-2026-000042 for Kantara Chapter 1 has been cancelled. Check your account for refund details, if applicable.',
    );
  });

  it('shares the free path key: one SMS per booking, whichever path ended it', () => {
    const ctx = {
      type: NotificationType.BOOKING_CANCELLED,
      channel: 'sms' as const,
      recipientRef: 'u1',
    };
    expect(dedupeKeyFor({ ...ctx, payload: PAYLOAD })).toBe(
      dedupeKeyFor({ ...ctx, payload: { ...PAYLOAD, refundStatus: 'NOTHING_TO_REFUND' } }),
    );
  });
});
