import { InventoryResolver } from '../../inventory.resolver';
import { InventoryProviderRegistry } from '../../inventory-provider.registry';
import { QubeMockInventoryProvider } from './qube-mock.provider';
import type { InventoryProvider, LockRequest } from '../../inventory-provider.interface';

/**
 * Two things that must be true before a single real seat is sold through a remote cinema.
 *
 * 1. Two customers reaching for the same seat: exactly one gets it.
 * 2. A provider outage NEVER sells local stock instead.
 *
 * The second is the launch-critical one, and it is the reason `failover: false` exists on this
 * provider. These seats belong to an exhibitor's system. If the resolver stepped past an
 * unreachable Qube to LOCAL inventory, ETicketsGo would sell seats it does not own and the
 * customer would find out at a cinema that has never heard of them.
 */
const lockReq = (bookingId: string, show: string, seatIds: string[]): LockRequest => ({
  experienceType: 'MOVIE',
  eventSessionId: show,
  bookingId,
  lines: [{ ticketTypeId: 'tt', quantity: seatIds.length, seatIds }],
  holdExpiresAt: new Date(Date.now() + 10 * 60_000),
});

describe('two customers, one seat', () => {
  let p: QubeMockInventoryProvider;

  beforeEach(() => {
    p = new QubeMockInventoryProvider();
    p.reset();
  });

  /** The 19:30 show on Screen 1, and seat F10 in it — the scenario as specified. */
  async function seatF10At1930() {
    const shows = await p.getShows({});
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const show = shows.find(
      (s) => local.format(s.startsAt) === '19:30' && s.screenExternalId.endsWith('-S1'),
    )!;
    const map = await p.getSeatMap(show.externalId);
    const f10 = map.seats.find((s) => s.label === 'F10')!;
    return { show: show.externalId, seatId: f10.externalId };
  }

  it('gives the seat to exactly one of two simultaneous requests', async () => {
    const { show, seatId } = await seatF10At1930();

    /*
      Fired together rather than sequentially. Sequential calls prove only that the second
      caller can read the first one's write; simultaneous ones are what actually happens at an
      on-sale, and what a check-then-write implementation gets wrong.
    */
    const [a, b] = await Promise.allSettled([
      p.lockInventory(lockReq('customer-a', show, [seatId])),
      p.lockInventory(lockReq('customer-b', show, [seatId])),
    ]);

    const winners = [a, b].filter((r) => r.status === 'fulfilled');
    const losers = [a, b].filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // And the loser is told something actionable, not a generic failure.
    const reason = (losers[0] as PromiseRejectedResult).reason as { code?: string };
    expect(['INVENTORY_ALREADY_HELD', 'INVENTORY_ALREADY_SOLD']).toContain(reason.code);
  });

  it('still gives it to exactly one when ten customers race for it', async () => {
    const { show, seatId } = await seatF10At1930();
    const attempts = Array.from({ length: 10 }, (_, i) =>
      p.lockInventory(lockReq(`customer-${i}`, show, [seatId])),
    );
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('the loser can take the seat once the winner’s hold lapses', async () => {
    // Losing a race is temporary; the seat is not gone, it is held. That distinction is what
    // INVENTORY_ALREADY_HELD exists to communicate.
    const { show, seatId } = await seatF10At1930();
    await p.lockInventory(lockReq('customer-a', show, [seatId]));
    await expect(p.lockInventory(lockReq('customer-b', show, [seatId]))).rejects.toBeDefined();
    p.expireAllHolds();
    await expect(p.lockInventory(lockReq('customer-b', show, [seatId]))).resolves.toBeDefined();
  });
});

describe('an outage must never reach local stock', () => {
  /**
   * A LOCAL provider that would happily sell anything, standing in for our own inventory.
   *
   * If the resolver ever fails over to this, the test fails — which is the entire point. It
   * records whether it was called so the assertion can be about what HAPPENED rather than
   * about which error came back.
   */
  class WouldSellAnything implements InventoryProvider {
    readonly name = 'local-test';
    readonly sourceKind = 'DIRECT' as const;
    readonly capabilities = { search: false, authority: 'LOCAL' as const, failover: false };
    wasCalled = false;

    async search() {
      return [];
    }
    async availability() {
      this.wasCalled = true;
      return { unitsByTicketType: { tt: 999 }, asOf: new Date(), authority: 'LOCAL' as const };
    }
    async lockInventory() {
      this.wasCalled = true;
      return { lockRef: 'local-lock', expiresAt: new Date(), authority: 'LOCAL' as const };
    }
    async confirmBooking() {
      this.wasCalled = true;
      return { confirmationRef: 'local-confirm', tickets: [] };
    }
    async cancelBooking() {}
    async refund() {}
    async sync() {
      return { itemsReconciled: 0, authority: 'LOCAL' as const };
    }
    async health() {
      return { healthy: true, checkedAt: new Date() };
    }
  }

  function resolverWith(qube: QubeMockInventoryProvider, local: WouldSellAnything) {
    const registry = new InventoryProviderRegistry();
    registry.register(qube);
    registry.register(local);
    // Qube first, local as the only other candidate: the exact shape in which a careless
    // failover would silently substitute our stock for the exhibitor's.
    const priority = { order: () => [qube.name.toLowerCase(), local.name] } as never;
    const health = { isHealthy: async () => true, invalidate: () => {} } as never;
    return new InventoryResolver(priority, health, registry);
  }

  it('refuses the sale rather than failing over when the provider is down', async () => {
    const qube = new QubeMockInventoryProvider();
    const local = new WouldSellAnything();
    const resolver = resolverWith(qube, local);
    qube.setOutage('unavailable');

    const shows = await new QubeMockInventoryProvider().getShows({});
    await expect(
      resolver.withFailover(
        {
          experienceType: 'MOVIE',
          eventSessionId: shows[0].externalId,
          // The session's binding to this provider. Remote authority is never a default.
          preferredProvider: 'qube_mock',
        },
        (p) => p.lockInventory(lockReq('bk-outage', shows[0].externalId, ['QBSEAT-any'])),
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_PROVIDER_UNAVAILABLE' });

    /*
      The assertion that matters. It is not enough that an error came back — the error could
      have come from the local provider too. Nothing may have reached local inventory at all.
    */
    expect(local.wasCalled).toBe(false);
  });

  it('refuses rather than failing over when the provider TIMES OUT', async () => {
    // A timeout is the more dangerous case: the remote system may well have taken the seats,
    // so selling a local seat instead risks two customers holding the same one.
    const qube = new QubeMockInventoryProvider();
    const local = new WouldSellAnything();
    const resolver = resolverWith(qube, local);
    qube.setOutage('timeout');

    const shows = await new QubeMockInventoryProvider().getShows({});
    await expect(
      resolver.withFailover(
        {
          experienceType: 'MOVIE',
          eventSessionId: shows[0].externalId,
          // The session's binding to this provider. Remote authority is never a default.
          preferredProvider: 'qube_mock',
        },
        (p) =>
          p.availability({
            experienceType: 'MOVIE',
            eventSessionId: shows[0].externalId,
            ticketTypeIds: ['tt'],
          }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(local.wasCalled).toBe(false);
  });

  it('does not report local availability when the remote authority is unreachable', async () => {
    /*
      The quietest version of the bug: no booking, just a seat map that says 999 seats are free
      because the fallback answered. A customer picks a seat that was never ours to offer.
    */
    const qube = new QubeMockInventoryProvider();
    const local = new WouldSellAnything();
    const resolver = resolverWith(qube, local);
    qube.setOutage('unavailable');

    await expect(
      resolver.withFailover(
        { experienceType: 'MOVIE', eventSessionId: 'any', preferredProvider: 'qube_mock' },
        (p) =>
          p.availability({ experienceType: 'MOVIE', eventSessionId: 'any', ticketTypeIds: ['tt'] }),
      ),
    ).rejects.toBeDefined();
    expect(local.wasCalled).toBe(false);
  });
});
