import type { InventoryProvider, LockRequest } from '../../inventory-provider.interface';
import { hasCinemaCatalogue, hasSeatMap } from '../../cinema-capabilities.interface';

/**
 * The behaviour every remote cinema provider must exhibit, written once.
 *
 * ── WHY A SHARED SUITE AND NOT PER-PROVIDER TESTS ──────────────────────────────────
 * The value of a provider seam is that the booking engine cannot tell which source served a
 * sale. That promise is only worth anything if every source behaves the same way at the
 * edges — the same refusal for a sold seat, the same answer to a retried hold, the same
 * meaning for an expired one. Per-provider tests drift: the second provider gets the tests
 * somebody remembered, and the differences surface as a production incident.
 *
 * So this is the contract, executable. When a real `QubeProvider` or a `VistaProvider` is
 * written, it is pointed at this suite and either passes or is not finished:
 *
 *     describeCinemaProviderContract('QUBE_MOCK', () => new QubeMockInventoryProvider());
 *
 * ── WHAT IT DELIBERATELY DOES NOT ASSERT ───────────────────────────────────────────
 * Anything specific to one vendor's identifiers, prices, layout or catalogue. Those differ by
 * definition and asserting them here would make the contract un-passable by the next provider,
 * which is exactly the failure it exists to prevent.
 */
export interface CinemaProviderHarness {
  provider: InventoryProvider;
  /** Reset to a known state between tests. */
  reset(): void;
  /** Force every live hold to have lapsed, so expiry is testable without waiting. */
  expireAllHolds(): void;
  /** Simulate the vendor being unreachable or unresponsive. */
  setOutage(mode: 'none' | 'unavailable' | 'timeout'): void;
  /** A show the provider knows about, and two free seats in it. */
  sampleShow(): Promise<{ showExternalId: string; seatIds: string[]; soldSeatId: string }>;
}

export function describeCinemaProviderContract(
  name: string,
  makeHarness: () => CinemaProviderHarness,
): void {
  describe(`${name} — cinema provider contract`, () => {
    let h: CinemaProviderHarness;

    const lockReq = (
      bookingId: string,
      showExternalId: string,
      seatIds: string[],
    ): LockRequest => ({
      experienceType: 'MOVIE',
      eventSessionId: showExternalId,
      bookingId,
      lines: [{ ticketTypeId: 'tt-contract', quantity: seatIds.length, seatIds }],
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
    });

    beforeEach(() => {
      h = makeHarness();
      h.reset();
    });

    describe('what it says about itself', () => {
      it('declares REMOTE authority', () => {
        // The whole point of the seam. A cinema POS owns its seats; we do not.
        expect(h.provider.capabilities.authority).toBe('REMOTE');
      });

      it('REFUSES failover, so an outage can never reach local stock', () => {
        /*
          Launch-critical. If this were true, an unreachable provider would let the resolver
          step past it to LOCAL inventory and sell seats belonging to somebody else's system —
          discovered by the customer at a cinema that has never heard of them.
        */
        expect(h.provider.capabilities.failover).toBe(false);
      });

      it('reports healthy when reachable and unhealthy when not', async () => {
        expect((await h.provider.health()).healthy).toBe(true);
        h.setOutage('unavailable');
        expect((await h.provider.health()).healthy).toBe(false);
      });
    });

    describe('catalogue and seat map', () => {
      it('publishes cinemas, screens, movies and shows with stable external ids', async () => {
        if (!hasCinemaCatalogue(h.provider)) return;
        const cinemas = await h.provider.getCinemas();
        expect(cinemas.length).toBeGreaterThan(0);
        // Identity is the external id. Titles and names change; ids must not.
        for (const c of cinemas) expect(c.externalId).toBeTruthy();

        const shows = await h.provider.getShows({});
        expect(shows.length).toBeGreaterThan(0);
        for (const s of shows) {
          expect(s.externalId).toBeTruthy();
          expect(s.startsAt instanceof Date).toBe(true);
          // A showtime with no screen is not bookable and no cinema is not locatable.
          expect(s.screenExternalId).toBeTruthy();
          expect(s.cinemaExternalId).toBeTruthy();
        }
      });

      it('gives every show the same set of external ids twice running', async () => {
        if (!hasCinemaCatalogue(h.provider)) return;
        const a = (await h.provider.getShows({})).map((s) => s.externalId).sort();
        const b = (await h.provider.getShows({})).map((s) => s.externalId).sort();
        // Ids that change between calls make every sync create duplicate internal rows.
        expect(a).toEqual(b);
      });

      it('returns a seat map with categories and identified seats', async () => {
        if (!hasSeatMap(h.provider)) return;
        const { showExternalId } = await h.sampleShow();
        const map = await h.provider.getSeatMap(showExternalId);
        expect(map.categories.length).toBeGreaterThan(0);
        expect(map.seats.length).toBeGreaterThan(0);
        for (const seat of map.seats) {
          expect(seat.externalId).toBeTruthy();
          expect(['AVAILABLE', 'HELD', 'SOLD', 'BLOCKED']).toContain(seat.state);
        }
      });
    });

    describe('holding seats', () => {
      it('holds free seats and reports when the hold lapses', async () => {
        const { showExternalId, seatIds } = await h.sampleShow();
        const res = await h.provider.lockInventory(lockReq('bk-1', showExternalId, seatIds));
        expect(res.lockRef).toBeTruthy();
        expect(res.authority).toBe('REMOTE');
        expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
      });

      it('is IDEMPOTENT: a retried hold returns the first one, not a second set of seats', async () => {
        /*
          A network blip during checkout retries the hold. Without this, the customer's own
          first hold is what makes their second one fail, and the room is held twice.
        */
        const { showExternalId, seatIds } = await h.sampleShow();
        const a = await h.provider.lockInventory(lockReq('bk-idem', showExternalId, seatIds));
        const b = await h.provider.lockInventory(lockReq('bk-idem', showExternalId, seatIds));
        expect(b.lockRef).toBe(a.lockRef);
      });

      it('refuses a seat somebody else already holds', async () => {
        const { showExternalId, seatIds } = await h.sampleShow();
        await h.provider.lockInventory(lockReq('bk-first', showExternalId, seatIds));
        await expect(
          h.provider.lockInventory(lockReq('bk-second', showExternalId, seatIds)),
        ).rejects.toMatchObject({ code: 'INVENTORY_ALREADY_HELD' });
      });

      it('refuses a seat the venue has already sold', async () => {
        const { showExternalId, soldSeatId } = await h.sampleShow();
        await expect(
          h.provider.lockInventory(lockReq('bk-sold', showExternalId, [soldSeatId])),
        ).rejects.toMatchObject({ code: 'INVENTORY_ALREADY_SOLD' });
      });

      it('refuses a seat that does not exist', async () => {
        const { showExternalId } = await h.sampleShow();
        await expect(
          h.provider.lockInventory(lockReq('bk-ghost', showExternalId, ['NO-SUCH-SEAT'])),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      });

      it('takes NO seats when any one of them is unavailable', async () => {
        /*
          A partial hold leaves a customer owning three of the four seats they asked for, with
          no way to say so — and the fourth is gone before anybody notices.
        */
        const { showExternalId, seatIds, soldSeatId } = await h.sampleShow();
        await expect(
          h.provider.lockInventory(lockReq('bk-partial', showExternalId, [seatIds[0], soldSeatId])),
        ).rejects.toBeDefined();
        // The free seat in that request must still be free for somebody else.
        const ok = await h.provider.lockInventory(
          lockReq('bk-after', showExternalId, [seatIds[0]]),
        );
        expect(ok.lockRef).toBeTruthy();
      });
    });

    describe('confirming', () => {
      it('turns a live hold into a booking', async () => {
        const { showExternalId, seatIds } = await h.sampleShow();
        await h.provider.lockInventory(lockReq('bk-ok', showExternalId, seatIds));
        const res = await h.provider.confirmBooking({
          experienceType: 'MOVIE',
          eventSessionId: showExternalId,
          bookingId: 'bk-ok',
          lines: [{ ticketTypeId: 'tt-contract', quantity: seatIds.length, seatIds }],
        });
        expect(res.confirmationRef).toBeTruthy();
        expect(res.tickets.length).toBe(seatIds.length);
      });

      it('is IDEMPOTENT: confirming twice returns one booking, not two', async () => {
        // This is what makes recovery from an ambiguous timeout safe.
        const { showExternalId, seatIds } = await h.sampleShow();
        await h.provider.lockInventory(lockReq('bk-twice', showExternalId, seatIds));
        const ctx = {
          experienceType: 'MOVIE' as const,
          eventSessionId: showExternalId,
          bookingId: 'bk-twice',
          lines: [{ ticketTypeId: 'tt-contract', quantity: seatIds.length, seatIds }],
        };
        const a = await h.provider.confirmBooking(ctx);
        const b = await h.provider.confirmBooking(ctx);
        expect(b.confirmationRef).toBe(a.confirmationRef);
      });

      it('refuses to confirm an expired hold rather than re-taking the seats', async () => {
        /*
          By then somebody else may hold them. "Confirm anyway" is how two customers end up
          with the same seat, and the second one finds out at the door.
        */
        const { showExternalId, seatIds } = await h.sampleShow();
        await h.provider.lockInventory(lockReq('bk-stale', showExternalId, seatIds));
        h.expireAllHolds();
        await expect(
          h.provider.confirmBooking({
            experienceType: 'MOVIE',
            eventSessionId: showExternalId,
            bookingId: 'bk-stale',
            lines: [{ ticketTypeId: 'tt-contract', quantity: seatIds.length, seatIds }],
          }),
        ).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
      });

      it('frees the seats when a hold lapses, so they can be sold again', async () => {
        const { showExternalId, seatIds } = await h.sampleShow();
        await h.provider.lockInventory(lockReq('bk-lapse', showExternalId, seatIds));
        h.expireAllHolds();
        const other = await h.provider.lockInventory(lockReq('bk-next', showExternalId, seatIds));
        expect(other.lockRef).toBeTruthy();
      });
    });

    describe('cancelling', () => {
      it('returns the seats to sale', async () => {
        const { showExternalId, seatIds } = await h.sampleShow();
        const ctx = {
          experienceType: 'MOVIE' as const,
          eventSessionId: showExternalId,
          bookingId: 'bk-cancel',
          lines: [{ ticketTypeId: 'tt-contract', quantity: seatIds.length, seatIds }],
        };
        await h.provider.lockInventory(lockReq('bk-cancel', showExternalId, seatIds));
        await h.provider.confirmBooking(ctx);
        await h.provider.cancelBooking(ctx);
        const again = await h.provider.lockInventory(lockReq('bk-resell', showExternalId, seatIds));
        expect(again.lockRef).toBeTruthy();
      });

      it('is safe to cancel something that was never held', async () => {
        // Compensation runs on paths where the hold may never have been taken. It must not
        // fail there, or the cleanup itself becomes the thing that needs cleaning up.
        const { showExternalId } = await h.sampleShow();
        await expect(
          h.provider.cancelBooking({
            experienceType: 'MOVIE',
            eventSessionId: showExternalId,
            bookingId: 'bk-never',
            lines: [],
          }),
        ).resolves.toBeUndefined();
      });
    });

    describe('when the provider misbehaves', () => {
      it('normalises an outage to INVENTORY_PROVIDER_UNAVAILABLE', async () => {
        const { showExternalId, seatIds } = await h.sampleShow();
        h.setOutage('unavailable');
        await expect(
          h.provider.lockInventory(lockReq('bk-down', showExternalId, seatIds)),
        ).rejects.toMatchObject({ code: 'INVENTORY_PROVIDER_UNAVAILABLE' });
      });

      it('reports a timeout as PROVIDER_TIMEOUT, which is NOT a failure', async () => {
        /*
          The most important distinction in an external POS integration. A request that timed
          out may have succeeded at the far end. Reporting it as "failed" is what causes a
          double booking, or a refund for a booking that exists. It has its own code so
          reconciliation can tell "we know it failed" from "we do not know".
        */
        const { showExternalId, seatIds } = await h.sampleShow();
        h.setOutage('timeout');
        await expect(
          h.provider.confirmBooking({
            experienceType: 'MOVIE',
            eventSessionId: showExternalId,
            bookingId: 'bk-unknown',
            lines: [{ ticketTypeId: 'tt-contract', quantity: seatIds.length, seatIds }],
          }),
        ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
      });
    });
  });
}
