import { BookingsService } from './bookings.service';

/**
 * Which discount codes a buyer is allowed to be SHOWN.
 *
 * ── THE RISK THIS GUARDS ───────────────────────────────────────────────────────────
 * The request was "show all the available promocodes as a dropdown". Taken literally that
 * publishes every active code — including the win-back rate mailed to lapsed customers, the
 * partner's code, and the influencer's. Those are worth exactly their scarcity, and leaking
 * them is silent and irreversible: a code buyers have already seen cannot be unseen.
 *
 * So the dropdown lists only what an organizer deliberately published. Private codes keep
 * working by being typed, which is the entire point of having them. Every test here is about
 * something NOT appearing.
 */
const NOW = new Date('2026-08-25T12:00:00Z');

function setup(coupons: Record<string, unknown>[]) {
  const findMany = jest.fn().mockResolvedValue(coupons);
  const prisma = {
    eventSession: {
      findUnique: jest.fn().mockResolvedValue({ event: { organizationId: 'org-1' } }),
    },
    coupon: { findMany },
  };
  const stub = {} as never;
  const service = new BookingsService(
    prisma as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  return { service, findMany };
}

const coupon = (over: Record<string, unknown> = {}) => ({
  code: 'FIRST10',
  type: 'PERCENT',
  value: 10,
  publicLabel: null,
  maxRedemptions: null,
  redemptions: 0,
  ...over,
});

describe('BookingsService.publicOffers', () => {
  it('asks the database for published codes only', async () => {
    // The filter is in the QUERY, not applied afterwards — a private code should never be
    // read into memory in a request that is going to be sent to a browser.
    const { service, findMany } = setup([]);
    await service.publicOffers('sess-1');
    expect(findMany.mock.calls[0][0].where).toMatchObject({ isPublic: true, status: 'ACTIVE' });
  });

  it('scopes to the selling organization plus platform-wide offers', async () => {
    // One organizer's promotion must not advertise itself on another's checkout.
    const { service, findMany } = setup([]);
    await service.publicOffers('sess-1');
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { organizationId: 'org-1' },
      { organizationId: null },
    ]);
  });

  it('hides a code that has been fully redeemed', async () => {
    // An exhausted code is not an offer. Showing one that cannot be applied is worse than
    // showing nothing, because the buyer tries it and is told no.
    const { service } = setup([coupon({ maxRedemptions: 5, redemptions: 5 })]);
    expect(await service.publicOffers('sess-1')).toEqual([]);
  });

  it('shows one that still has redemptions left', async () => {
    const { service } = setup([coupon({ maxRedemptions: 5, redemptions: 4 })]);
    expect(await service.publicOffers('sess-1')).toEqual([{ code: 'FIRST10', label: '10% off' }]);
  });

  it('prefers the organizer’s own wording when they wrote some', async () => {
    const { service } = setup([coupon({ publicLabel: '10% off your first booking' })]);
    expect((await service.publicOffers('sess-1'))[0].label).toBe('10% off your first booking');
  });

  it('describes a fixed discount in money, not in minor units', async () => {
    const { service } = setup([coupon({ type: 'FIXED', value: 5000 })]);
    expect((await service.publicOffers('sess-1'))[0].label).toBe('50 off');
  });

  it('returns nothing for a session that does not exist', async () => {
    const prisma = {
      eventSession: { findUnique: jest.fn().mockResolvedValue(null) },
      coupon: { findMany: jest.fn() },
    };
    const stub = {} as never;
    const service = new BookingsService(
      prisma as never,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
    );
    expect(await service.publicOffers('nope')).toEqual([]);
    expect(prisma.coupon.findMany).not.toHaveBeenCalled();
  });

  it('never returns anything a query for private codes would have matched', async () => {
    /*
      The property, stated directly: whatever the database holds, the caller only ever sees
      rows the query already restricted. This asserts the shape of the WHERE rather than
      trusting the service to filter after the fact — post-filtering is how a private code
      ends up in a response body during some later refactor.
    */
    const { service, findMany } = setup([]);
    await service.publicOffers('sess-1');
    const where = findMany.mock.calls[0][0].where;
    expect(where.isPublic).toBe(true);
    expect(Object.keys(where)).toContain('AND');
    void NOW;
  });
});
