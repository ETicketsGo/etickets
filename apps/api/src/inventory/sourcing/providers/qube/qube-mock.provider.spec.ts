import { QubeMockInventoryProvider } from './qube-mock.provider';
import { QubeInventoryProvider } from './qube.provider';
import { describeCinemaProviderContract } from './cinema-provider-contract';
import { QUBE_MOCK_CINEMA, QUBE_MOCK_PRESOLD_LABELS } from './qube-mock.fixture';
import { hasCinemaCatalogue, hasSeatMap } from '../../cinema-capabilities.interface';
import type { LockRequest } from '../../inventory-provider.interface';

/**
 * The Qube sandbox provider, against the shared cinema-provider contract plus the
 * behaviours specific to being a REMOTE authority inside this codebase.
 */
let shared: QubeMockInventoryProvider;

describeCinemaProviderContract('QUBE_MOCK', () => {
  const provider = new QubeMockInventoryProvider();
  shared = provider;
  return {
    provider,
    reset: () => provider.reset(),
    expireAllHolds: () => provider.expireAllHolds(),
    setOutage: (mode) => provider.setOutage(mode),
    sampleShow: async () => {
      const show = (await provider.getShows({}))[0];
      const map = await provider.getSeatMap(show.externalId);
      const free = map.seats.filter((s) => s.state === 'AVAILABLE' && s.kind === 'SEAT');
      const sold = map.seats.find((s) => s.state === 'SOLD')!;
      return {
        showExternalId: show.externalId,
        seatIds: [free[0].externalId, free[1].externalId],
        soldSeatId: sold.externalId,
      };
    },
  };
});

describe('QUBE_MOCK as a remote authority', () => {
  let p: QubeMockInventoryProvider;
  beforeEach(() => {
    p = new QubeMockInventoryProvider();
    p.reset();
  });

  const lockReq = (bookingId: string, show: string, seatIds: string[]): LockRequest => ({
    experienceType: 'MOVIE',
    eventSessionId: show,
    bookingId,
    lines: [{ ticketTypeId: 'tt', quantity: seatIds.length, seatIds }],
    holdExpiresAt: new Date(Date.now() + 10 * 60_000),
  });

  it('advertises the capabilities it actually has, by having the methods', () => {
    // Guards rather than boolean flags: a provider claiming `supportsSeatMap: true` without a
    // getSeatMap compiles perfectly and fails in production.
    expect(hasCinemaCatalogue(p)).toBe(true);
    expect(hasSeatMap(p)).toBe(true);
    expect(hasSeatMap(new QubeInventoryProvider())).toBe(false);
  });

  it('builds showtimes in the CINEMA’s zone, not the server’s', async () => {
    /*
      A show is a wall-clock fact about a building. 19:30 in Hyderabad is 19:30 whether the
      server is in London or Virginia, and a fixture built from local time would schedule a
      different day's programme depending on where it ran.
    */
    const shows = await p.getShows({});
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: QUBE_MOCK_CINEMA.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const times = new Set(shows.map((s) => local.format(s.startsAt)));
    expect(times).toContain('19:30');
    expect(times).toContain('10:30');
  });

  it('filters shows by the cinema’s calendar day, not UTC', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: QUBE_MOCK_CINEMA.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const todays = await p.getShows({ date: today });
    expect(todays.length).toBeGreaterThan(0);
    // A UTC-based filter would drop the 22:30 show, which is the next UTC day in +05:30.
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: QUBE_MOCK_CINEMA.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(todays.map((s) => local.format(s.startsAt))).toContain('22:30');
  });

  it('never offers an aisle or a blocked seat for sale', async () => {
    const show = (await p.getShows({}))[0];
    const map = await p.getSeatMap(show.externalId);
    const gap = map.seats.find((s) => s.kind === 'GAP')!;
    const blocked = map.seats.find((s) => s.state === 'BLOCKED')!;
    await expect(
      p.lockInventory(lockReq('bk-gap', show.externalId, [gap.externalId])),
    ).rejects.toBeDefined();
    await expect(
      p.lockInventory(lockReq('bk-blk', show.externalId, [blocked.externalId])),
    ).rejects.toBeDefined();
  });

  it('keeps the venue’s pre-sold seats sold', async () => {
    // The room is not empty just because ETicketsGo has not sold anything in it.
    const show = (await p.getShows({}))[0];
    const map = await p.getSeatMap(show.externalId);
    const sold = map.seats.filter((s) => s.state === 'SOLD').map((s) => s.label);
    expect(sold.sort()).toEqual([...QUBE_MOCK_PRESOLD_LABELS].sort());
  });

  it('reports availability as REMOTE and stale-able, never as local truth', async () => {
    const show = (await p.getShows({}))[0];
    const snap = await p.availability({
      experienceType: 'MOVIE',
      eventSessionId: show.externalId,
      ticketTypeIds: ['tt'],
    });
    expect(snap.authority).toBe('REMOTE');
    expect(snap.asOf instanceof Date).toBe(true);
  });

  it('drops availability as seats are taken', async () => {
    const show = (await p.getShows({}))[0];
    const before = (
      await p.availability({
        experienceType: 'MOVIE',
        eventSessionId: show.externalId,
        ticketTypeIds: ['tt'],
      })
    ).unitsByTicketType.tt;
    const map = await p.getSeatMap(show.externalId);
    const free = map.seats.filter((s) => s.state === 'AVAILABLE' && s.kind === 'SEAT').slice(0, 3);
    await p.lockInventory(
      lockReq(
        'bk-avail',
        show.externalId,
        free.map((s) => s.externalId),
      ),
    );
    const after = (
      await p.availability({
        experienceType: 'MOVIE',
        eventSessionId: show.externalId,
        ticketTypeIds: ['tt'],
      })
    ).unitsByTicketType.tt;
    expect(after).toBe(before - 3);
  });

  describe('recovering from an ambiguous confirmation', () => {
    it('can be asked what it actually did, instead of guessing', async () => {
      /*
        Scenario C. Confirmation timed out: the outcome is UNKNOWN. Deciding by assumption
        either double-books the seat (assume failure, retry elsewhere) or refunds a booking
        that exists (assume failure, refund). Asking the provider is the only correct move,
        and a provider that cannot answer this question cannot be integrated safely — which
        is why it is on the list of things to ask Qube.
      */
      const show = (await p.getShows({}))[0];
      const map = await p.getSeatMap(show.externalId);
      const seat = map.seats.find((s) => s.state === 'AVAILABLE' && s.kind === 'SEAT')!;
      const ctx = {
        experienceType: 'MOVIE' as const,
        eventSessionId: show.externalId,
        bookingId: 'bk-amb',
        lines: [{ ticketTypeId: 'tt', quantity: 1, seatIds: [seat.externalId] }],
      };
      await p.lockInventory(lockReq('bk-amb', show.externalId, [seat.externalId]));

      // Unknown before the confirmation lands.
      expect((await p.getExternalBooking('bk-amb')).status).toBe('NOT_FOUND');
      await p.confirmBooking(ctx);
      // Known after, and the same reference the confirmation returned.
      const lookup = await p.getExternalBooking('bk-amb');
      expect(lookup.status).toBe('CONFIRMED');
      expect(lookup.externalBookingId).toBe('QBBK-bk-amb');
    });

    it('a retry after an unknown outcome does not create a second booking', async () => {
      const show = (await p.getShows({}))[0];
      const map = await p.getSeatMap(show.externalId);
      const seat = map.seats.find((s) => s.state === 'AVAILABLE' && s.kind === 'SEAT')!;
      const ctx = {
        experienceType: 'MOVIE' as const,
        eventSessionId: show.externalId,
        bookingId: 'bk-retry',
        lines: [{ ticketTypeId: 'tt', quantity: 1, seatIds: [seat.externalId] }],
      };
      await p.lockInventory(lockReq('bk-retry', show.externalId, [seat.externalId]));
      const first = await p.confirmBooking(ctx);

      // The caller never saw the first answer — it timed out on the wire — and retries.
      const second = await p.confirmBooking(ctx);
      expect(second.confirmationRef).toBe(first.confirmationRef);

      // And exactly one seat is sold, not two.
      const after = await p.getSeatMap(show.externalId);
      const sold = after.seats.filter((s) => s.state === 'SOLD').length;
      expect(sold).toBe(QUBE_MOCK_PRESOLD_LABELS.length + 1);
    });
  });

  describe('compensation', () => {
    it('Scenario A — payment fails after a hold: cancelling frees the seats', async () => {
      const show = (await p.getShows({}))[0];
      const map = await p.getSeatMap(show.externalId);
      const seats = map.seats
        .filter((s) => s.state === 'AVAILABLE' && s.kind === 'SEAT')
        .slice(0, 2);
      const ids = seats.map((s) => s.externalId);
      await p.lockInventory(lockReq('bk-payfail', show.externalId, ids));

      await p.cancelBooking({
        experienceType: 'MOVIE',
        eventSessionId: show.externalId,
        bookingId: 'bk-payfail',
        lines: [],
      });

      const after = await p.getSeatMap(show.externalId);
      for (const id of ids) {
        expect(after.seats.find((s) => s.externalId === id)?.state).toBe('AVAILABLE');
      }
    });

    it('Scenario B — a refund returns the seats to sale', async () => {
      const show = (await p.getShows({}))[0];
      const map = await p.getSeatMap(show.externalId);
      const seat = map.seats.find((s) => s.state === 'AVAILABLE' && s.kind === 'SEAT')!;
      const ctx = {
        experienceType: 'MOVIE' as const,
        eventSessionId: show.externalId,
        bookingId: 'bk-refund',
        lines: [{ ticketTypeId: 'tt', quantity: 1, seatIds: [seat.externalId] }],
      };
      await p.lockInventory(lockReq('bk-refund', show.externalId, [seat.externalId]));
      await p.confirmBooking(ctx);
      await p.refund({
        experienceType: 'MOVIE',
        eventSessionId: show.externalId,
        bookingId: 'bk-refund',
        tickets: [{ ticketTypeId: 'tt' }],
      });
      const after = await p.getSeatMap(show.externalId);
      expect(after.seats.find((s) => s.externalId === seat.externalId)?.state).toBe('AVAILABLE');
    });
  });
});

describe('the real Qube provider', () => {
  it('refuses every operation, and says what is missing', async () => {
    const q = new QubeInventoryProvider();
    await expect(
      q.availability({ experienceType: 'MOVIE', eventSessionId: 'x', ticketTypeIds: [] }),
    ).rejects.toThrow(/QUBE_PROVIDER_NOT_CONFIGURED/);
    await expect(
      q.lockInventory({
        experienceType: 'MOVIE',
        eventSessionId: 'x',
        bookingId: 'b',
        lines: [],
        holdExpiresAt: new Date(),
      }),
    ).rejects.toThrow(/QUBE_PROVIDER_NOT_CONFIGURED/);
  });

  it('reports unhealthy rather than throwing, so it stays out of every candidate set', async () => {
    // Throwing here would take the registry down at boot; reporting unhealthy just means the
    // monitor never offers it.
    const health = await new QubeInventoryProvider().health();
    expect(health.healthy).toBe(false);
    expect(health.reason).toBe('QUBE_PROVIDER_NOT_CONFIGURED');
  });

  it('still declares REMOTE authority and refuses failover before it is built', () => {
    /*
      Stated up front so that if it is ever registered before it is implemented, the resolver
      treats it with the right caution — rather than the rules being discovered later, by an
      overselling incident.
    */
    const caps = new QubeInventoryProvider().capabilities;
    expect(caps.authority).toBe('REMOTE');
    expect(caps.failover).toBe(false);
  });
});

afterAll(() => {
  shared?.reset();
});
