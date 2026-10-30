import { DeliveryState } from '@eticketsgo/shared-types';
import { PhoneOtpDeliverySink } from './phone-otp-delivery.sink';
import { ProviderEventSinks } from '../notifications/delivery/provider-event-sinks';
import { DeliveryRecorderService } from '../notifications/delivery/delivery-recorder.service';

/**
 * A sign-in code's text has no NotificationDelivery row, so its delivery report used to stay
 * AWAITING_CORRELATION forever. The sink matches it to the PhoneOtp row instead.
 */

type Row = {
  id: string;
  provider: string | null;
  providerMessageId: string | null;
  deliveryStatus: string | null;
  deliveredAt: Date | null;
};

function fakePrisma(rows: Row[]) {
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const value = r[k as keyof Row];
      if (v && typeof v === 'object' && 'in' in (v as object)) {
        return ((v as { in: unknown[] }).in as unknown[]).includes(value);
      }
      if (v && typeof v === 'object' && 'notIn' in (v as object)) {
        return !((v as { notIn: unknown[] }).notIn as unknown[]).includes(value);
      }
      return value === v;
    });
  const pick = (where: { OR?: Record<string, unknown>[] } & Record<string, unknown>) => {
    const { OR, ...rest } = where;
    return rows.filter((r) => matches(r, rest) && (!OR || OR.some((o) => matches(r, o))));
  };
  return {
    phoneOtp: {
      findFirst: jest.fn(async ({ where }) => pick(where)[0] ?? null),
      updateMany: jest.fn(async ({ where, data }) => {
        const hit = pick(where);
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    notificationDelivery: { findFirst: jest.fn(async () => null) },
  };
}

const sent = (): Row => ({
  id: 'otp1',
  provider: 'msg91',
  providerMessageId: 'req-otp-1',
  deliveryStatus: DeliveryState.ACCEPTED,
  deliveredAt: null,
});

const event = (state: DeliveryState, id = 'req-otp-1') => ({
  provider: 'msg91',
  providerMessageId: id,
  eventId: `${id}:${state}`,
  state,
  providerStatus: state === DeliveryState.DELIVERED ? '1' : '2',
  occurredAt: new Date('2026-10-29T10:00:00Z'),
});

describe('PhoneOtpDeliverySink', () => {
  it('applies a msg91 DELIVERED report to the matching sign-in code', async () => {
    const row = sent();
    const prisma = fakePrisma([row]);
    const sink = new PhoneOtpDeliverySink(prisma as never, new ProviderEventSinks());

    await expect(sink.apply(event(DeliveryState.DELIVERED))).resolves.toBe('applied');
    expect(row.deliveryStatus).toBe('DELIVERED');
    expect(row.deliveredAt).toEqual(new Date('2026-10-29T10:00:00Z'));
  });

  it("answers 'unknown' for a message id it never sent", async () => {
    const prisma = fakePrisma([sent()]);
    const sink = new PhoneOtpDeliverySink(prisma as never, new ProviderEventSinks());
    await expect(sink.apply(event(DeliveryState.DELIVERED, 'someone-else'))).resolves.toBe(
      'unknown',
    );
  });

  it('is idempotent: a duplicate report changes nothing', async () => {
    const row = sent();
    const prisma = fakePrisma([row]);
    const sink = new PhoneOtpDeliverySink(prisma as never, new ProviderEventSinks());

    await sink.apply(event(DeliveryState.DELIVERED));
    const first = { ...row };
    await expect(
      sink.apply({
        ...event(DeliveryState.DELIVERED),
        occurredAt: new Date('2026-10-29T11:00:00Z'),
      }),
    ).resolves.toBe('ignored');
    expect(row).toEqual(first);
  });

  it('never downgrades DELIVERED, but records a failure on an undelivered code', async () => {
    const row = sent();
    const prisma = fakePrisma([row]);
    const sink = new PhoneOtpDeliverySink(prisma as never, new ProviderEventSinks());

    await sink.apply(event(DeliveryState.DELIVERED));
    await expect(sink.apply(event(DeliveryState.UNDELIVERED))).resolves.toBe('ignored');
    await expect(sink.apply(event(DeliveryState.ACCEPTED))).resolves.toBe('ignored');
    expect(row.deliveryStatus).toBe('DELIVERED');

    const other = { ...sent(), id: 'otp2', providerMessageId: 'req-otp-2' };
    const sink2 = new PhoneOtpDeliverySink(fakePrisma([other]) as never, new ProviderEventSinks());
    await expect(sink2.apply(event(DeliveryState.UNDELIVERED, 'req-otp-2'))).resolves.toBe(
      'applied',
    );
    expect(other.deliveryStatus).toBe('UNDELIVERED');
    expect(other.deliveredAt).toBeNull();
  });

  it('is reached through DeliveryRecorderService, which is what the webhook and the replay call', async () => {
    const row = sent();
    const prisma = fakePrisma([row]);
    const sinks = new ProviderEventSinks();
    new PhoneOtpDeliverySink(prisma as never, sinks).onModuleInit();
    const recorder = new DeliveryRecorderService(
      prisma as never,
      undefined as never,
      undefined,
      undefined,
      sinks,
    );

    await expect(recorder.applyProviderEvent(event(DeliveryState.DELIVERED))).resolves.toBe(
      'applied',
    );
    expect(row.deliveryStatus).toBe('DELIVERED');
  });
});
