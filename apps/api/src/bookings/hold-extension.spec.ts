import { BookingStatus } from '@eticketsgo/shared-types';
import { BookingsService } from './bookings.service';

/**
 * Giving a buyer more time on a hold, without letting anyone sit on inventory for ever.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The seats are held on a countdown and there was no way to stop it. For most people that is
 * an inconvenience. For somebody reading with a screen reader, typing one-handed, or
 * translating the page as they go, a clock that cannot be paused is the difference between
 * being able to buy a ticket and not — which is why WCAG 2.2.1 (Timing Adjustable) is a
 * Level A criterion, the strictest tier, and why this was a plain failure of it.
 *
 * ── THE TENSION THIS FILE IS REALLY ABOUT ──────────────────────────────────────────
 * The hold exists so two people cannot buy the same seat. Extending it without limit would
 * let one person lock a sold-out show out of everybody else's reach for as long as they
 * liked. So every test here is about where the line sits: extend freely up to a bound, and
 * refuse in the cases where extending would take something from somebody else.
 */
const OWNER = { id: 'u-1', email: 'b@t.test', fullName: 'B', roles: [] } as never;
const OTHER = { id: 'u-2', email: 'c@t.test', fullName: 'C', roles: [] } as never;

const IN_FIVE_MINUTES = () => new Date(Date.now() + 5 * 60 * 1000);
const FIVE_MINUTES_AGO = () => new Date(Date.now() - 5 * 60 * 1000);

function setup(
  over: {
    status?: string;
    holdExpiresAt?: Date;
    holdExtensions?: number;
    userId?: string | null;
    maxExtensions?: number;
    missing?: boolean;
  } = {},
) {
  const booking = over.missing
    ? null
    : {
        id: 'bk-1',
        userId: over.userId === undefined ? 'u-1' : over.userId,
        status: over.status ?? BookingStatus.PENDING_PAYMENT,
        holdExpiresAt: over.holdExpiresAt ?? IN_FIVE_MINUTES(),
        holdExtensions: over.holdExtensions ?? 0,
        organizationId: 'org-1',
      };

  const update = jest.fn().mockImplementation(async ({ data }) => ({
    holdExpiresAt: data.holdExpiresAt,
    holdExtensions: (booking?.holdExtensions ?? 0) + 1,
  }));

  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking), update },
  };
  const config = {
    get: (key: string) =>
      key === 'BOOKING_HOLD_MINUTES'
        ? 10
        : key === 'BOOKING_HOLD_MAX_EXTENSIONS'
          ? over.maxExtensions
          : undefined,
  };

  const stub = {} as never;
  const service = new BookingsService(
    prisma as never,
    stub, // pricing
    stub, // pricingStrategies
    stub, // audit
    stub, // inventory
    stub, // addOnInventory
    stub, // metrics
    stub, // lockShadow
    stub, // bookingShadow
    config as never,
  );
  return { service, prisma, update };
}

describe('extending a booking hold', () => {
  it('pushes the deadline out and counts the extension', async () => {
    const { service, update } = setup();
    const before = Date.now();
    const result = await service.extendHold(OWNER, 'bk-1');

    expect(result.holdExtensions).toBe(1);
    expect(result.extensionsRemaining).toBe(9);
    // A fresh full window, so the buyer gets a predictable amount of time rather than
    // whatever happened to be left plus a bit.
    const granted = update.mock.calls[0][0].data.holdExpiresAt as Date;
    expect(granted.getTime()).toBeGreaterThanOrEqual(before + 9 * 60 * 1000);
  });

  it('measures the new window from now, not from what was left', async () => {
    /*
      Otherwise a buyer who asks with nine minutes remaining accumulates nineteen, and asking
      early is rewarded over asking when you actually need it. The purpose is "give me time to
      finish", not "let me sit on this".
    */
    const { service, update } = setup({ holdExpiresAt: new Date(Date.now() + 9 * 60 * 1000) });
    await service.extendHold(OWNER, 'bk-1');

    const granted = update.mock.calls[0][0].data.holdExpiresAt as Date;
    expect(granted.getTime()).toBeLessThan(Date.now() + 11 * 60 * 1000);
  });

  it('allows ten extensions, because the criterion asks for ten', async () => {
    // WCAG 2.2.1's "extend" route is explicit about the number. Nine would not satisfy it.
    const { service } = setup({ holdExtensions: 9 });
    const result = await service.extendHold(OWNER, 'bk-1');
    expect(result.holdExtensions).toBe(10);
    expect(result.extensionsRemaining).toBe(0);
  });

  it('refuses the eleventh, and says how to proceed', async () => {
    /*
      The bound is the whole reason this is safe to offer. Without it one person could hold a
      sold-out show away from everybody else indefinitely, which is a different kind of harm
      from the one the criterion is preventing.
    */
    const { service, update } = setup({ holdExtensions: 10 });
    await expect(service.extendHold(OWNER, 'bk-1')).rejects.toThrow(
      /already been extended 10 times/i,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('lets an operator lower the bound', async () => {
    // A high-demand on-sale is an operator's judgement. Lowering it is a documented trade.
    const { service } = setup({ holdExtensions: 2, maxExtensions: 3 });
    const result = await service.extendHold(OWNER, 'bk-1');
    expect(result.maxHoldExtensions).toBe(3);
    expect(result.extensionsRemaining).toBe(0);
  });

  it('will not resurrect a hold that has already expired', async () => {
    /*
      The seats have gone back to the pool, or are about to. Extending here would be selling
      something that may already belong to somebody else — the exact harm the timer prevents.
    */
    const { service, update } = setup({ holdExpiresAt: FIVE_MINUTES_AGO() });
    await expect(service.extendHold(OWNER, 'bk-1')).rejects.toThrow(/already expired/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses on a booking that is not awaiting payment', async () => {
    const { service } = setup({ status: BookingStatus.CONFIRMED });
    await expect(service.extendHold(OWNER, 'bk-1')).rejects.toThrow(/not waiting for payment/i);
  });

  it('will not let one person extend another person’s hold', async () => {
    const { service, update } = setup();
    await expect(service.extendHold(OTHER, 'bk-1')).rejects.toThrow(/cannot change this booking/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a guest extend the booking they hold by its id', async () => {
    // A guest booking has no owner and is reached by an unguessable id — the same rule the
    // payment path already applies, so checkout works the same way with or without an account.
    const { service } = setup({ userId: null });
    await expect(service.extendHold(null, 'bk-1')).resolves.toMatchObject({ holdExtensions: 1 });
  });

  it('does not invent a booking that is not there', async () => {
    const { service } = setup({ missing: true });
    await expect(service.extendHold(OWNER, 'nope')).rejects.toThrow(/Booking not found/i);
  });
});
