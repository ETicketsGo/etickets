import { Logger } from '@nestjs/common';
import { FailureClass, NotificationType, WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../../common/errors';
import { RazorpayWebhookService } from '../../payments/razorpay/razorpay-webhook.service';
import { StripeWebhookService } from '../../payments/webhooks/stripe/stripe-webhook.service';
import { RazorpayWebhookProcessor } from '../../payments/razorpay/razorpay-webhook.processor';
import { StripeWebhookProcessor } from '../../payments/webhooks/stripe/stripe-webhook.processor';
import { PendingPaymentRecoveryService } from '../../payments/recovery/pending-payment-recovery.service';
import { FinanceReconciliationService } from '../../payments/finance/finance-reconciliation.service';
import { NotificationService } from '../../notifications/notification.service';
import { TransportError } from '../../notifications/channels/transports/transport-http';
import { OpsService } from '../ops.service';
import { OpsAlertService, type OpsAlert } from './ops-alert.service';

/**
 * Every hook next to a money-critical path: it fires, it carries no secret or customer data,
 * and the path decides and writes EXACTLY what it did without alerts.
 *
 * Each trigger is run twice where it matters - once with no alert service (the old code) and
 * once with an alert service whose email AND Redis both throw - and the results and writes are
 * compared. No email leaves this file: the transport is a fake that throws or records.
 */

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

function spyAlerts() {
  const alerts: OpsAlert[] = [];
  return {
    alerts,
    service: {
      notify: jest.fn(async (a: OpsAlert) => {
        alerts.push(a);
        return { raised: true, count: 1, delivered: 1 };
      }),
    },
  };
}

/** A real alert service whose email and Redis both throw: the worst day for the alert path. */
function hostileAlerts(): OpsAlertService {
  const fail = async () => {
    throw new Error('down');
  };
  return new OpsAlertService(
    { get: (k: string) => (k === 'OPS_ALERT_EMAILS' ? 'ops@eticketsgo.test' : 'QA') } as never,
    { name: 'ses', send: fail } as never,
    { client: { incr: fail, pexpire: fail, set: fail, getset: fail, get: fail } } as never,
  );
}

const SECRET_SIGNATURE = 'f00dfeed-the-signature-must-never-be-mailed';

function badSignatureAdapter() {
  return {
    verifySignedEnvelope: jest.fn(() => {
      throw new AppException(ErrorCodes.PAYMENT_WEBHOOK_INVALID, 'Invalid webhook signature.', 400);
    }),
  };
}

function webhookPrisma() {
  return {
    webhookEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'we_1' }),
      update: jest.fn().mockResolvedValue({ id: 'we_1' }),
    },
  };
}

describe('payment webhook rejected for signature', () => {
  const body = JSON.stringify({ payload: { payment: { entity: { email: 'ada@example.com' } } } });

  function razorpay(alerts?: unknown) {
    const prisma = webhookPrisma();
    const service = new RazorpayWebhookService(
      prisma as never,
      { get: () => badSignatureAdapter() } as never,
      { process: jest.fn() } as never,
      { recordPaymentWebhook: jest.fn() } as never,
      alerts as never,
    );
    return { service, prisma };
  }
  function stripe(alerts?: unknown) {
    const prisma = webhookPrisma();
    const service = new StripeWebhookService(
      prisma as never,
      { get: () => badSignatureAdapter() } as never,
      { process: jest.fn() } as never,
      { recordPaymentWebhook: jest.fn() } as never,
      alerts as never,
    );
    return { service, prisma };
  }

  it('Razorpay: alerts with the provider and event id, never the signature or body', async () => {
    const spy = spyAlerts();
    const { service } = razorpay(spy.service);
    await expect(service.ingest(body, SECRET_SIGNATURE, 'evt_42')).rejects.toMatchObject({
      code: ErrorCodes.PAYMENT_WEBHOOK_INVALID,
    });
    expect(spy.alerts).toHaveLength(1);
    expect(spy.alerts[0]).toMatchObject({
      kind: 'WEBHOOK_SIGNATURE_REJECTED',
      key: 'razorpay',
      facts: { provider: 'razorpay', providerEventId: 'evt_42', bodyBytes: body.length },
    });
    const text = JSON.stringify(spy.alerts[0]);
    expect(text).not.toContain(SECRET_SIGNATURE);
    expect(text).not.toContain('ada@example.com');
  });

  it('Stripe: alerts the same way', async () => {
    const spy = spyAlerts();
    const { service } = stripe(spy.service);
    await expect(service.ingest(body, SECRET_SIGNATURE)).rejects.toMatchObject({
      code: ErrorCodes.PAYMENT_WEBHOOK_INVALID,
    });
    expect(spy.alerts[0]).toMatchObject({ kind: 'WEBHOOK_SIGNATURE_REJECTED', key: 'stripe' });
    expect(JSON.stringify(spy.alerts[0])).not.toContain(SECRET_SIGNATURE);
  });

  it.each([
    ['razorpay', razorpay],
    ['stripe', stripe],
  ])('%s: the same refusal and no writes, with alerts off, on, or broken', async (_n, build) => {
    for (const alerts of [undefined, spyAlerts().service, hostileAlerts()]) {
      const { service, prisma } = build(alerts);
      await expect(service.ingest(body, SECRET_SIGNATURE, 'evt_1')).rejects.toMatchObject({
        code: ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        message: 'Invalid webhook signature.',
      });
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
      expect(prisma.webhookEvent.update).not.toHaveBeenCalled();
    }
  });
});

describe('expiry guard finds a capture on a booking it was about to release', () => {
  const booking = {
    id: 'bk1',
    payment: { provider: 'razorpay', status: 'PROCESSING', providerOrderId: 'order_1' },
  };
  const captured = [
    { providerRef: 'pay_1', status: 'CAPTURED', amountMinor: 51_918, currency: 'INR' },
  ];

  function make(alerts: unknown, processVerifiedEvent: jest.Mock) {
    return new PendingPaymentRecoveryService(
      { get: () => ({ findOrderPayments: jest.fn().mockResolvedValue(captured) }) } as never,
      { processVerifiedEvent } as never,
      { recordPaymentWebhook: jest.fn() } as never,
      alerts as never,
    );
  }

  it('alerts when the booking was recovered', async () => {
    const spy = spyAlerts();
    const svc = make(spy.service, jest.fn().mockResolvedValue({ status: 'confirmed' }));
    await expect(svc.guardExpiry(booking)).resolves.toBe('recovered');
    expect(spy.alerts).toEqual([
      expect.objectContaining({
        kind: 'EXPIRY_FOUND_CAPTURE',
        key: 'bk1',
        facts: expect.objectContaining({
          bookingId: 'bk1',
          providerOrderId: 'order_1',
          providerRef: 'pay_1',
          amountMinor: 51_918,
          outcome: 'recovered',
        }),
      }),
    ]);
  });

  it('alerts, and still holds the stock, when recovery is refused', async () => {
    const spy = spyAlerts();
    const refuse = jest
      .fn()
      .mockRejectedValue(new AppException(ErrorCodes.BOOKING_NOT_PAYABLE, 'cancelled', 409));
    await expect(make(spy.service, refuse).guardExpiry(booking)).resolves.toBe('hold_back');
    expect(spy.alerts[0].facts).toMatchObject({
      outcome: 'recovery_failed',
      errorCode: ErrorCodes.BOOKING_NOT_PAYABLE,
    });
  });

  it('decides the same with alerts off, on, or broken', async () => {
    for (const alerts of [undefined, spyAlerts().service, hostileAlerts()]) {
      const ok = jest.fn().mockResolvedValue({ status: 'confirmed' });
      await expect(make(alerts, ok).guardExpiry(booking)).resolves.toBe('recovered');
      expect(ok).toHaveBeenCalledTimes(1);
      const refuse = jest.fn().mockRejectedValue(new Error('amount'));
      await expect(make(alerts, refuse).guardExpiry(booking)).resolves.toBe('hold_back');
    }
  });

  it('does not alert for an ordinary abandoned cart', async () => {
    const spy = spyAlerts();
    const svc = new PendingPaymentRecoveryService(
      { get: () => ({ findOrderPayments: jest.fn().mockResolvedValue([]) }) } as never,
      { processVerifiedEvent: jest.fn() } as never,
      { recordPaymentWebhook: jest.fn() } as never,
      spy.service as never,
    );
    await expect(svc.guardExpiry(booking)).resolves.toBe('release');
    expect(spy.alerts).toEqual([]);
  });
});

describe('a new finance discrepancy is opened', () => {
  function make(alerts: unknown, existing: unknown = null) {
    const prisma = {
      reconciliationDiscrepancy: {
        findFirst: jest.fn().mockResolvedValue(existing),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'disc_1',
          ...data,
        })),
      },
    };
    const svc = new FinanceReconciliationService(
      prisma as never,
      { record: jest.fn() } as never,
      { get: jest.fn() } as never,
      { get: () => 'PRODUCTION' } as never,
      alerts as never,
    );
    return { svc, prisma };
  }
  const candidate = {
    type: 'PAYMENT_MISSING_INTERNALLY' as const,
    provider: 'razorpay',
    entityRef: 'pay_1',
    amountMinor: 51_918,
    currency: 'INR',
    detail: 'Provider captured 51918 INR (pay_1) for booking b1 (status EXPIRED).',
  };

  it('alerts once with the discrepancy id, type, ref and amount', async () => {
    const spy = spyAlerts();
    await expect(make(spy.service).svc.fileDiscrepancy(candidate)).resolves.toBe(true);
    expect(spy.alerts).toEqual([
      expect.objectContaining({
        kind: 'FINANCE_DISCREPANCY_OPENED',
        key: 'PAYMENT_MISSING_INTERNALLY',
        facts: expect.objectContaining({
          discrepancyId: 'disc_1',
          entityRef: 'pay_1',
          amountMinor: 51_918,
          currency: 'INR',
          paymentEnv: 'PRODUCTION',
        }),
      }),
    ]);
  });

  it('does not alert when an open one already exists (nothing new was opened)', async () => {
    const spy = spyAlerts();
    await expect(make(spy.service, { id: 'old' }).svc.fileDiscrepancy(candidate)).resolves.toBe(
      false,
    );
    expect(spy.alerts).toEqual([]);
  });

  it('writes the same row with alerts off, on, or broken', async () => {
    const rows: unknown[] = [];
    for (const alerts of [undefined, spyAlerts().service, hostileAlerts()]) {
      const { svc, prisma } = make(alerts);
      await expect(svc.fileDiscrepancy(candidate)).resolves.toBe(true);
      rows.push(prisma.reconciliationDiscrepancy.create.mock.calls);
    }
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[2]).toEqual(rows[0]);
  });
});

describe('a payment webhook is dead-lettered', () => {
  const record = {
    id: 'we_1',
    provider: 'razorpay',
    providerEventId: 'evt_dead',
    eventType: 'payment.captured',
    attempts: 6,
    payload: {
      object: {
        payment: { entity: { id: 'pay_1', amount: 100, notes: { bookingId: 'b1' } } },
      },
    },
  };
  function prismaFor(r: Record<string, unknown>) {
    return {
      webhookEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(r),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  }
  const failing = () => ({
    processVerifiedEvent: jest.fn().mockRejectedValue(new Error('confirm refused')),
  });

  it('Razorpay: alerts on the last attempt only', async () => {
    const spy = spyAlerts();
    const prisma = prismaFor(record);
    const p = new RazorpayWebhookProcessor(
      prisma as never,
      failing() as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      spy.service as never,
    );
    await p.process('we_1');
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processingStatus: WebhookProcessingStatus.DEAD_LETTER }),
      }),
    );
    expect(spy.alerts).toEqual([
      expect.objectContaining({
        kind: 'WEBHOOK_DEAD_LETTERED',
        key: 'razorpay',
        facts: expect.objectContaining({ providerEventId: 'evt_dead', attempts: 6 }),
      }),
    ]);

    const early = spyAlerts();
    await new RazorpayWebhookProcessor(
      prismaFor({ ...record, attempts: 2 }) as never,
      failing() as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      early.service as never,
    ).process('we_1');
    expect(early.alerts).toEqual([]);
  });

  it('Stripe: alerts on the last attempt', async () => {
    const spy = spyAlerts();
    const stripeRecord = {
      ...record,
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      payload: {
        object: { id: 'pi_1', amount: 100, amount_received: 100, metadata: { bookingId: 'b1' } },
      },
    };
    const p = new StripeWebhookProcessor(
      prismaFor(stripeRecord) as never,
      failing() as never,
      {} as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      spy.service as never,
    );
    await p.process('we_1');
    expect(spy.alerts[0]).toMatchObject({ kind: 'WEBHOOK_DEAD_LETTERED', key: 'stripe' });
  });

  it('Razorpay: the same writes with alerts off, on, or broken', async () => {
    const writes: unknown[] = [];
    for (const alerts of [undefined, spyAlerts().service, hostileAlerts()]) {
      const prisma = prismaFor(record);
      const audit = { record: jest.fn() };
      await new RazorpayWebhookProcessor(
        prisma as never,
        failing() as never,
        {} as never,
        {} as never,
        audit as never,
        alerts as never,
      ).process('we_1');
      writes.push([prisma.webhookEvent.update.mock.calls, audit.record.mock.calls]);
    }
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[2]).toEqual(writes[0]);
  });
});

describe('a customer notification stops retrying', () => {
  function make(alerts: unknown, err: Error, attempts = 0) {
    const row = {
      id: 'n1',
      type: NotificationType.BOOKING_CONFIRMED,
      channel: 'email',
      locale: 'en',
      userId: null,
      toEmail: 'ada@example.com',
      payload: {},
      status: 'PENDING',
      attempts,
      sendReason: null,
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]) }),
      ),
      notification: {
        findMany: jest.fn().mockResolvedValue([row]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new NotificationService(
      prisma as never,
      { render: jest.fn().mockReturnValue({ subject: 'S', body: 'B' }) } as never,
      {} as never,
      {
        resolve: jest
          .fn()
          .mockReturnValue({ key: 'email', deliver: jest.fn().mockRejectedValue(err) }),
      } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      alerts as never,
    );
    return { service, prisma };
  }

  it('alerts for a permanent failure, by channel and cause, without the address', async () => {
    const spy = spyAlerts();
    const err = new TransportError(
      'ses returned HTTP 400: Email address is not verified: ada@example.com',
      'ses',
      FailureClass.PERMANENT_REJECTION,
      400,
    );
    const { service } = make(spy.service, err);
    await expect(service.dispatchDue(new Date('2026-06-01T00:00:00Z'))).resolves.toMatchObject({
      failed: 1,
    });
    expect(spy.alerts).toEqual([
      expect.objectContaining({
        kind: 'NOTIFICATION_FAILED',
        key: `email:${FailureClass.PERMANENT_REJECTION}`,
        facts: expect.objectContaining({ notificationId: 'n1', permanent: true }),
      }),
    ]);
    expect(JSON.stringify(spy.alerts)).not.toContain('ada@example.com');
  });

  it('does not alert while the message will still be retried', async () => {
    const spy = spyAlerts();
    const { service } = make(spy.service, new Error('socket hang up'));
    await expect(service.dispatchDue(new Date('2026-06-01T00:00:00Z'))).resolves.toMatchObject({
      retried: 1,
    });
    expect(spy.alerts).toEqual([]);
  });

  it('records the same outcome with alerts off, on, or broken', async () => {
    const writes: unknown[] = [];
    for (const alerts of [undefined, spyAlerts().service, hostileAlerts()]) {
      const { service, prisma } = make(alerts, new Error('socket hang up'), 9);
      await service.dispatchDue(new Date('2026-06-01T00:00:00Z'));
      writes.push(
        prisma.notification.update.mock.calls.map((c) => {
          const data = { ...(c[0] as { data: Record<string, unknown> }).data };
          return data;
        }),
      );
    }
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[2]).toEqual(writes[0]);
  });
});

describe('admin ops health shows whether alerts are configured', () => {
  function ops(alerts?: unknown) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([1]),
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const redis = { client: { ping: jest.fn().mockResolvedValue('PONG') } };
    const queue = { getJobCounts: jest.fn().mockResolvedValue({ failed: 0 }), close: jest.fn() };
    return new OpsService(
      prisma as never,
      redis as never,
      { get: (_k: string, d?: unknown) => d } as never,
      queue as never,
      undefined,
      alerts as never,
    );
  }

  it('reports "not configured" with the reason, and leaves overall status alone', async () => {
    const alerts = new OpsAlertService({ get: () => undefined } as never);
    const h = await ops(alerts).health();
    expect(h.status).toBe('ok');
    expect(h.opsAlerts).toMatchObject({
      configured: false,
      status: 'not_configured',
      lastAlertAt: null,
    });
    expect(h.opsAlerts.reason).toMatch(/OPS_ALERT_EMAILS/);
  });

  it('reports configured and the last alert time', async () => {
    const alerts = new OpsAlertService(
      { get: (k: string) => (k === 'OPS_ALERT_EMAILS' ? 'ops@eticketsgo.test' : 'QA') } as never,
      { name: 'ses', send: jest.fn().mockResolvedValue({ provider: 'ses' }) } as never,
    );
    await alerts.notify({
      kind: 'WEBHOOK_SIGNATURE_REJECTED',
      key: 'razorpay',
      summary: 'x',
      facts: {},
      where: 'y',
    });
    const h = await ops(alerts).health();
    expect(h.opsAlerts).toMatchObject({ configured: true, recipients: 1, emailProvider: 'ses' });
    expect(h.opsAlerts.lastAlertAt).toEqual(expect.any(String));
  });

  it('still answers when no alert service is wired', async () => {
    const h = await ops(undefined).health();
    expect(h.opsAlerts).toMatchObject({ configured: false, status: 'not_configured' });
  });
});
