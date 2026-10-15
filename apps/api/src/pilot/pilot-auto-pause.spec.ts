import { OpsAlertService } from '../ops/alerts/ops-alert.service';
import {
  captureNotAppliedAlert,
  confirmationFailedAlert,
  discrepancyOpenedAlert,
  expiryFoundCaptureAlert,
  webhookSignatureAlert,
} from '../ops/alerts/ops-alert-messages';
import type { PilotEnv } from './pilot-config';
import { PilotAutoPauseService } from './pilot-auto-pause.service';
import { PilotGuardService } from './pilot-guard.service';

/**
 * The automatic pause: each trigger the owner named pauses the right events, writes the audit
 * row, raises the ops alert, and nothing it does can fail the money path that raised the alert.
 *
 * Fails on the code before this change: nothing subscribed to the ops alerts, so every alert
 * below left the event on sale.
 */
const PILOT_ORG = 'org-pilot';
const PILOT: PilotEnv = {
  PILOT_MODE: 'on',
  PILOT_ALLOWED_ORGANIZATION_IDS: PILOT_ORG,
  PILOT_MAX_ORDER_MINOR: '200000',
  PILOT_MAX_DAILY_SALES_MINOR: '2500000',
};

interface Ev {
  id: string;
  organizationId: string;
  status: string;
  pausedByAdminAt: Date | null;
}

function setup(env: PilotEnv | null = PILOT, opts: { failUpdate?: boolean } = {}) {
  const events: Ev[] = [
    { id: 'ev-pilot', organizationId: PILOT_ORG, status: 'PUBLISHED', pausedByAdminAt: null },
    { id: 'ev-pilot-2', organizationId: PILOT_ORG, status: 'PUBLISHED', pausedByAdminAt: null },
    { id: 'ev-pilot-draft', organizationId: PILOT_ORG, status: 'DRAFT', pausedByAdminAt: null },
    { id: 'ev-other', organizationId: 'org-other', status: 'PUBLISHED', pausedByAdminAt: null },
  ];
  const bookings: Record<string, { eventId: string; organizationId: string }> = {
    'bk-pilot': { eventId: 'ev-pilot', organizationId: PILOT_ORG },
    'bk-other': { eventId: 'ev-other', organizationId: 'org-other' },
  };
  const prisma = {
    booking: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        bookings[where.id] ? { id: where.id, ...bookings[where.id] } : null,
      ),
    },
    payment: {
      findFirst: jest.fn(async ({ where }: { where: { OR: { providerRef?: string }[] } }) =>
        where.OR.some((o) => o.providerRef === 'pay_pilot') ? { bookingId: 'bk-pilot' } : null,
      ),
    },
    refund: { findFirst: jest.fn().mockResolvedValue(null) },
    event: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          events.find((e) => e.id === where.id) ?? null,
      ),
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { organizationId: { in: string[] }; status: { in: string[] } };
        }) =>
          events.filter(
            (e) =>
              where.organizationId.in.includes(e.organizationId) &&
              where.status.in.includes(e.status),
          ),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: { in: string[] } };
          data: { status: string; pausedByAdminAt: Date };
        }) => {
          if (opts.failUpdate) throw new Error('database is away');
          const e = events.find((x) => x.id === where.id && where.status.in.includes(x.status));
          if (!e) return { count: 0 };
          e.status = data.status;
          e.pausedByAdminAt = data.pausedByAdminAt;
          return { count: 1 };
        },
      ),
    },
  };
  const values: Record<string, string | undefined> = { ...(env ?? {}) };
  const guard = new PilotGuardService(prisma as never, { get: (k: string) => values[k] } as never);
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  let clock = Date.parse('2026-10-15T10:00:00Z');
  const now = () => clock;
  const alerts = new OpsAlertService(undefined, undefined, undefined, now);
  const notify = jest.spyOn(alerts, 'notify');
  const service = new PilotAutoPauseService(
    prisma as never,
    guard,
    audit as never,
    alerts,
    undefined,
    now,
  );
  service.onModuleInit();
  return {
    service,
    events,
    audit,
    alerts,
    notify,
    prisma,
    status: (id: string) => events.find((e) => e.id === id)!.status,
    advance: (ms: number) => (clock += ms),
  };
}

const capture = (bookingId: string) =>
  captureNotAppliedAlert({
    bookingId,
    paymentId: 'pay-1',
    provider: 'razorpay',
    providerRef: 'pay_x',
    amountMinor: 100_000,
    currency: 'INR',
    bookingStatus: 'EXPIRED',
    duplicate: false,
  });

describe('a booking-level trigger pauses that event', () => {
  it.each([
    [
      'money captured for a booking that cannot take it',
      capture('bk-pilot'),
      'CAPTURE_NOT_APPLIED',
    ],
    [
      'confirmation failed after payment',
      confirmationFailedAlert({
        bookingId: 'bk-pilot',
        providerRef: 'pay_x',
        amountMinor: 100_000,
        error: new Error('boom'),
      }),
      'CONFIRMATION_FAILED_AFTER_PAYMENT',
    ],
    [
      'a paid booking the expiry sweep could not recover',
      expiryFoundCaptureAlert({
        bookingId: 'bk-pilot',
        provider: 'razorpay',
        providerOrderId: 'order_x',
        providerRef: 'pay_x',
        amountMinor: 100_000,
        currency: 'INR',
        outcome: 'recovery_failed',
      }),
      'PAID_BOOKING_NOT_RECOVERED',
    ],
  ])('%s', async (_l, alert, trigger) => {
    const { service, status, audit, notify } = setup();
    const out = await service.handle(alert);

    expect(out).toEqual({ trigger, pausedEventIds: ['ev-pilot'] });
    expect(status('ev-pilot')).toBe('PAUSED');
    // Only that event: the organizer's other show keeps selling.
    expect(status('ev-pilot-2')).toBe('PUBLISHED');
    expect(audit.record).toHaveBeenCalledWith({
      actorUserId: null,
      organizationId: PILOT_ORG,
      action: 'EVENT_AUTO_PAUSED',
      entityType: 'Event',
      entityId: 'ev-pilot',
      metadata: expect.objectContaining({
        status: 'PAUSED',
        actor: 'system',
        reason: `Pilot auto-pause: ${trigger}`,
        trigger,
        bookingId: 'bk-pilot',
      }),
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'PILOT_AUTO_PAUSED',
        facts: expect.objectContaining({ pausedEventIds: 'ev-pilot', trigger }),
      }),
    );
  });

  it('sets pausedByAdminAt, so only an admin can resume it', async () => {
    const { service, events } = setup();
    await service.handle(capture('bk-pilot'));
    expect(events[0].pausedByAdminAt).toBeInstanceOf(Date);
  });

  it('leaves a recovered expiry alone: that booking was confirmed', async () => {
    const { service, status } = setup();
    await service.handle(
      expiryFoundCaptureAlert({
        bookingId: 'bk-pilot',
        provider: 'razorpay',
        providerOrderId: 'order_x',
        providerRef: 'pay_x',
        amountMinor: 100_000,
        currency: 'INR',
        outcome: 'recovered',
      }),
    );
    expect(status('ev-pilot')).toBe('PUBLISHED');
  });

  it('does not pause another organizer event', async () => {
    const { service, status, audit } = setup();
    expect(await service.handle(capture('bk-other'))).toEqual({
      trigger: null,
      pausedEventIds: [],
    });
    expect(status('ev-other')).toBe('PUBLISHED');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('writes nothing twice when the same event is already paused', async () => {
    const { service, audit } = setup();
    await service.handle(capture('bk-pilot'));
    await service.handle(capture('bk-pilot'));
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});

describe('a reconciliation mismatch on a pilot payment', () => {
  const discrepancy = (entityRef: string) =>
    discrepancyOpenedAlert({
      discrepancyId: 'd1',
      type: 'AMOUNT_MISMATCH',
      provider: 'razorpay',
      entityRef,
      amountMinor: 100_000,
      currency: 'INR',
      env: 'TEST',
      detail: 'ours 1000, theirs 900',
    });

  it('pauses the event of the payment it names', async () => {
    const { service, status } = setup();
    expect(await service.handle(discrepancy('pay_pilot'))).toEqual({
      trigger: 'RECONCILIATION_MISMATCH',
      pausedEventIds: ['ev-pilot'],
    });
    expect(status('ev-pilot')).toBe('PAUSED');
  });

  it('pauses the event when the discrepancy names the booking itself', async () => {
    const { service, status } = setup();
    await service.handle(discrepancy('bk-pilot'));
    expect(status('ev-pilot')).toBe('PAUSED');
  });

  it('does nothing for a reference that is not ours', async () => {
    const { service, events } = setup();
    await service.handle(discrepancy('pay_unknown'));
    expect(events.every((e) => e.status !== 'PAUSED')).toBe(true);
  });
});

describe('webhook signature rejections', () => {
  const reject = () => webhookSignatureAlert('razorpay', 'evt_1', 120);

  it('pause every pilot event on sale at the third inside ten minutes, and nothing before', async () => {
    const { service, status, audit } = setup();
    await service.handle(reject());
    await service.handle(reject());
    expect(status('ev-pilot')).toBe('PUBLISHED');

    const out = await service.handle(reject());
    expect(out).toEqual({
      trigger: 'WEBHOOK_SIGNATURE_REJECTIONS',
      pausedEventIds: ['ev-pilot', 'ev-pilot-2'],
    });
    expect(status('ev-pilot-draft')).toBe('DRAFT');
    expect(status('ev-other')).toBe('PUBLISHED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'EVENT_AUTO_PAUSED',
        actorUserId: null,
        metadata: expect.objectContaining({
          trigger: 'WEBHOOK_SIGNATURE_REJECTIONS',
          rejectionsInWindow: 3,
        }),
      }),
    );
  });

  it('forgets rejections older than ten minutes', async () => {
    const { service, status, advance } = setup();
    await service.handle(reject());
    await service.handle(reject());
    advance(10 * 60 * 1000 + 1);
    await service.handle(reject());
    expect(status('ev-pilot')).toBe('PUBLISHED');
  });

  it('honours PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD=1', async () => {
    const { service, status } = setup({ ...PILOT, PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD: '1' });
    await service.handle(reject());
    expect(status('ev-pilot')).toBe('PAUSED');
  });
});

describe('when it does nothing', () => {
  it('pilot off: no trigger pauses anything', async () => {
    const { service, events, prisma } = setup(null);
    await service.handle(capture('bk-pilot'));
    for (let i = 0; i < 5; i++) await service.handle(webhookSignatureAlert('razorpay', 'e', 1));
    expect(events.every((e) => e.status !== 'PAUSED')).toBe(true);
    expect(prisma.event.updateMany).not.toHaveBeenCalled();
  });

  it('PILOT_AUTO_PAUSE=off: no trigger pauses anything', async () => {
    const { service, status } = setup({ ...PILOT, PILOT_AUTO_PAUSE: 'off' });
    await service.handle(capture('bk-pilot'));
    expect(status('ev-pilot')).toBe('PUBLISHED');
  });

  it('ignores its own alert, so a pause cannot loop', async () => {
    const { service, prisma } = setup();
    const out = await service.handle({
      kind: 'PILOT_AUTO_PAUSED',
      key: 'x',
      summary: 'x',
      facts: { bookingId: 'bk-pilot' },
      where: 'x',
    });
    expect(out.pausedEventIds).toEqual([]);
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
  });
});

describe('the money path is never at risk', () => {
  it('is wired to the ops alerts: notify alone pauses the event', async () => {
    const { alerts, status } = setup();
    await alerts.notify(capture('bk-pilot'));
    // The listener runs on its own promise; let it finish.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(status('ev-pilot')).toBe('PAUSED');
  });

  it('a pause that fails does not reject handle', async () => {
    const { service } = setup(PILOT, { failUpdate: true });
    await expect(service.handle(capture('bk-pilot'))).resolves.toEqual({
      trigger: 'CAPTURE_NOT_APPLIED',
      pausedEventIds: [],
    });
  });

  it('a listener that throws does not reach the caller of notify', async () => {
    const alerts = new OpsAlertService();
    alerts.subscribe(() => {
      throw new Error('listener exploded');
    });
    alerts.subscribe(async () => Promise.reject(new Error('async listener exploded')));
    await expect(alerts.notify(capture('bk-pilot'))).resolves.toMatchObject({ raised: true });
  });

  it('notify does not wait for a slow listener', async () => {
    const alerts = new OpsAlertService();
    let finished = false;
    alerts.subscribe(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            finished = true;
            r();
          }, 50),
        ),
    );
    await alerts.notify(capture('bk-pilot'));
    expect(finished).toBe(false);
  });
});
