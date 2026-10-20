import { BookingStatus, ExperienceType, NotificationType } from '@eticketsgo/shared-types';
import { PaymentsService } from './payments.service';
import { MetricsService } from '../metrics/metrics.service';
import { BookingReferenceService } from '../bookings/booking-reference.service';
import { AddOnInventoryService } from '../commerce/addon-inventory.service';

/**
 * What the confirmation carries to get the buyer to their tickets.
 *
 * Reported by the owner: an account holder's BOOKING_CONFIRMED carried only the booking
 * reference. A guest got an access link; the person with an account got nothing to press.
 * Now the account holder's confirmation links to the booking's tickets page on the customer
 * site, and the guest's is exactly what it was.
 */
const SITE = 'https://shop.walk.eticketsgo.com';

function setup(opts: { userId: string | null; config?: Record<string, string> }) {
  const booking = {
    id: 'bk-1',
    status: BookingStatus.PENDING_PAYMENT,
    eventSessionId: 'sess-1',
    organizationId: 'org-1',
    buyerName: 'F',
    buyerEmail: 'buyer@t.test',
    userId: opts.userId,
    holdExpiresAt: new Date(Date.now() + 900_000),
    couponId: null,
    totalMinor: 0,
    items: [{ ticketTypeId: 'tt-1', quantity: 1 }],
    event: {
      title: 'Walk Show',
      experienceType: ExperienceType.EVENT,
      isFree: true,
      organizationId: 'org-1',
      venue: { country: 'India', timezone: 'Asia/Kolkata' },
    },
    eventSession: { startsAt: new Date(Date.now() + 7 * 86_400_000), screen: null },
  };
  const tx = {
    booking: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    bookingReferenceCounter: {
      upsert: jest.fn().mockResolvedValue({ scope: 'IND-2026', value: 7 }),
    },
    ticket: { create: jest.fn().mockResolvedValue({}) },
    guestBookingAccess: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
    sendCritical: jest.fn().mockResolvedValue(undefined),
  };
  const config = { APP_ENV: 'QA', CUSTOMER_WEB_URL: SITE, ...(opts.config ?? {}) };
  const service = new PaymentsService(
    prisma as never,
    { verifyWebhook: jest.fn() } as never,
    { signEvent: jest.fn() } as never,
    { createPayment: jest.fn(), refund: jest.fn() } as never,
    { get: jest.fn() } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    notifications as never,
    {
      forSeating: jest
        .fn()
        .mockReturnValue({ confirm: jest.fn().mockResolvedValue([{ ticketTypeId: 'tt-1' }]) }),
    } as never,
    new AddOnInventoryService(),
    new MetricsService(),
    new BookingReferenceService(),
    { issueForBooking: jest.fn().mockResolvedValue(undefined) } as never,
    { get: jest.fn((key: string) => (config as Record<string, string>)[key]) } as never,
    { onPaymentSucceeded: jest.fn().mockResolvedValue(undefined) } as never,
    { createOrder: jest.fn(), verify: jest.fn() } as never,
    {
      recordInTransaction: jest.fn().mockResolvedValue(0),
      deliverAfterCommit: jest.fn().mockResolvedValue(undefined),
    } as never,
    { onConfirmed: async () => undefined, preConfirm: async () => ({ handled: false }) } as never,
  );
  const confirmation = () =>
    notifications.sendCritical.mock.calls
      .map((c) => c[1])
      .find((n: { type: string }) => n.type === NotificationType.BOOKING_CONFIRMED);
  return { service, tx, confirmation };
}

describe('the BOOKING_CONFIRMED payload', () => {
  it("links an account holder to the booking's tickets page on the customer site", async () => {
    const { service, tx, confirmation } = setup({ userId: 'u-1' });
    await service.confirmFreeBooking('bk-1');

    expect(confirmation()).toMatchObject({
      userId: 'u-1',
      payload: {
        bookingId: 'bk-1',
        link: `${SITE}/account/bookings/bk-1/tickets`,
        linkTo: 'ACCOUNT_TICKETS',
      },
    });
    // A page that asks them to sign in, not a credential: no guest token is minted.
    expect(tx.guestBookingAccess.create).not.toHaveBeenCalled();
  });

  it('gives a guest the access link and nothing else, exactly as before', async () => {
    const { service, confirmation } = setup({ userId: null });
    await service.confirmFreeBooking('bk-1');

    const payload = confirmation()!.payload as Record<string, unknown>;
    expect(String(payload.link)).toMatch(new RegExp(`^${SITE}/booking/access/[A-Za-z0-9_-]+$`));
    expect(payload).not.toHaveProperty('linkTo');
  });

  it('still confirms, without the button, when the customer site is not configured', async () => {
    // A deployment's missing variable must cost the button, never the tickets.
    const { service, confirmation } = setup({ userId: 'u-1', config: { CUSTOMER_WEB_URL: '' } });
    await expect(service.confirmFreeBooking('bk-1')).resolves.toMatchObject({
      status: 'confirmed',
    });
    const payload = confirmation()!.payload as Record<string, unknown>;
    expect(payload.link).toBeUndefined();
    expect(payload).not.toHaveProperty('linkTo');
  });
});
