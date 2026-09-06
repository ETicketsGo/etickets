import { QubeMockInventoryProvider } from '../../inventory/sourcing/providers/qube/qube-mock.provider';
import { QubeMockExternalBookingProvider } from './qube-mock-external-booking.provider';
import { InventoryResolver } from '../../inventory/sourcing/inventory.resolver';
import { InventoryProviderRegistry } from '../../inventory/sourcing/inventory-provider.registry';
import {
  needsSeatLevelInventory,
  requireSeatMapCapability,
} from '../../inventory/sourcing/cinema-capabilities.interface';
import type { InventoryProvider } from '../../inventory/sourcing/inventory-provider.interface';

/**
 * The checkout seam, exercised the way the orchestrator uses it.
 *
 * ── WHAT THIS PROVES AND WHAT IT DOES NOT ──────────────────────────────────────────
 * The orchestrator resolves an `InventoryProvider` to establish AUTHORITY, then runs the
 * reservation through an `ExternalBookingProvider`. These tests drive both seams in that
 * order, through the real `InventoryResolver`, and assert on which provider was selected and
 * what the local fallback was asked to do.
 *
 * They do NOT stand up the full Nest booking workflow with a database. That is the remaining
 * gap and it is stated plainly in the report rather than dressed up: a passing test here means
 * the seams compose correctly, not that a customer has bought a seat end to end.
 */
const inventory = () => {
  const p = new QubeMockInventoryProvider();
  p.reset();
  return p;
};

/** A LOCAL provider that would sell anything, so "was it asked?" is answerable. */
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
    return { lockRef: 'local', expiresAt: new Date(), authority: 'LOCAL' as const };
  }
  async confirmBooking() {
    this.wasCalled = true;
    return { confirmationRef: 'local', tickets: [] };
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
  const priority = { order: () => [qube.name.toLowerCase(), local.name] } as never;
  const health = { isHealthy: async () => true, invalidate: () => {} } as never;
  return new InventoryResolver(priority, health, registry);
}

/** Seat F10 on the 19:30 show, as the mission specifies. */
async function f10(p: QubeMockInventoryProvider) {
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const show = (await p.getShows({})).find(
    (s) => local.format(s.startsAt) === '19:30' && s.screenExternalId.endsWith('-S1'),
  )!;
  const map = await p.getSeatMap(show.externalId);
  return { show: show.externalId, seat: map.seats.find((s) => s.label === 'F10')!.externalId };
}

describe('checkout routes through the resolver to QUBE_MOCK', () => {
  it('resolves the REMOTE provider, not local inventory', async () => {
    const qube = inventory();
    const local = new WouldSellAnything();
    const resolver = resolverWith(qube, local);

    // The pin is the session's BINDING — the ProviderMapping row an operator approved. The
    // orchestrator reads it from the session; here it is supplied directly.
    const chosen = await resolver.resolve({
      experienceType: 'MOVIE',
      eventSessionId: 'x',
      preferredProvider: 'qube_mock',
    });

    // The assertion the mission asks for: provider resolved = QUBE_MOCK.
    expect(chosen.name).toBe('QUBE_MOCK');
    expect(chosen.capabilities.authority).toBe('REMOTE');
    expect(chosen.capabilities.failover).toBe(false);
    expect(local.wasCalled).toBe(false);
  });

  it('is NOT selected for an unbound session, however high its priority', async () => {
    /*
      Remote authority is a binding, never a default. Before this rule the decision was global:
      putting an external source first in INVENTORY_PROVIDER_PRIORITY routed every session to
      it — including events whose seats we own and whose buyers have never heard of the vendor.

      QUBE_MOCK is first in priority order here and still must not be chosen.
    */
    const qube = inventory();
    const local = new WouldSellAnything();
    const resolver = resolverWith(qube, local);

    const chosen = await resolver.resolve({ experienceType: 'MOVIE', eventSessionId: 'x' });

    expect(chosen.name).toBe('local-test');
    expect(chosen.capabilities.authority).toBe('LOCAL');
  });

  it('reserves, confirms, and leaves the seat SOLD at the remote authority', async () => {
    const qube = inventory();
    const booking = new QubeMockExternalBookingProvider(qube);
    const { show, seat } = await f10(qube);

    const reservation = await booking.createReservation({
      providerInventoryRef: show,
      selection: { inventoryType: 'SEAT', seatRefs: [seat] },
      idempotencyKey: 'wf-confirm-1',
    });
    expect(reservation.outcome).toBe('OK');
    expect(reservation.providerReservationId).toBeTruthy();

    const confirmed = await booking.confirmReservation({
      providerReservationId: reservation.providerReservationId!,
      idempotencyKey: 'wf-confirm-1',
    });
    expect(confirmed.outcome).toBe('OK');
    expect(confirmed.providerBookingId).toBeTruthy();

    /*
      Remote authority, asserted where it matters: the REMOTE system says the seat is sold.
      ETicketsGo may coordinate locally, but it is not the thing that decides whether F10 is
      gone — the cinema is.
    */
    const after = await qube.getSeatMap(show);
    expect(after.seats.find((s) => s.externalId === seat)?.state).toBe('SOLD');
  });

  it('two customers, same seat, through the booking seam: exactly one confirms', async () => {
    const qube = inventory();
    const booking = new QubeMockExternalBookingProvider(qube);
    const { show, seat } = await f10(qube);

    const attempt = (key: string) =>
      booking.createReservation({
        providerInventoryRef: show,
        selection: { inventoryType: 'SEAT', seatRefs: [seat] },
        idempotencyKey: key,
      });

    const [a, b] = await Promise.all([attempt('wf-a'), attempt('wf-b')]);
    const ok = [a, b].filter((r) => r.outcome === 'OK');
    const refused = [a, b].filter((r) => r.outcome !== 'OK');

    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // CONFLICT, not REJECTED: the seat is held, not gone, and the difference is what the
    // customer is told.
    expect(refused[0].outcome).toBe('CONFLICT');
  });

  it('a retried reservation returns the same one, so a blip cannot double-hold', async () => {
    const qube = inventory();
    const booking = new QubeMockExternalBookingProvider(qube);
    const { show, seat } = await f10(qube);
    const req = {
      providerInventoryRef: show,
      selection: { inventoryType: 'SEAT' as const, seatRefs: [seat] },
      idempotencyKey: 'wf-retry',
    };
    const first = await booking.createReservation(req);
    const again = await booking.createReservation(req);
    expect(again.providerReservationId).toBe(first.providerReservationId);
  });
});

describe('payment fails after a remote hold', () => {
  it('cancelling releases the seat at the provider', async () => {
    const qube = inventory();
    const booking = new QubeMockExternalBookingProvider(qube);
    const { show, seat } = await f10(qube);

    const reserved = await booking.createReservation({
      providerInventoryRef: show,
      selection: { inventoryType: 'SEAT', seatRefs: [seat] },
      idempotencyKey: 'wf-payfail',
    });
    /*
      Cancelled by RESERVATION reference, which is how the orchestrator has it: every call
      after the reservation carries its own idempotency key, so the key identifies the CALL and
      only the reference identifies the booking.
    */
    const cancelled = await booking.cancelReservation({
      providerReservationId: reserved.providerReservationId,
      idempotencyKey: 'wf-payfail:cancel',
    });
    expect(cancelled.outcome).toBe('OK');

    const after = await qube.getSeatMap(show);
    expect(after.seats.find((s) => s.externalId === seat)?.state).toBe('AVAILABLE');
  });
});

describe('an ambiguous confirmation', () => {
  it('is reported as AMBIGUOUS, never as failure', async () => {
    const qube = inventory();
    const booking = new QubeMockExternalBookingProvider(qube);
    const { show, seat } = await f10(qube);
    await booking.createReservation({
      providerInventoryRef: show,
      selection: { inventoryType: 'SEAT', seatRefs: [seat] },
      idempotencyKey: 'wf-amb',
    });

    qube.setOutage('timeout');
    const confirmed = await booking.confirmReservation({
      providerReservationId: 'ignored',
      idempotencyKey: 'wf-amb',
    });
    /*
      The single most important mapping in this adapter. REJECTED or RETRYABLE here would send
      the orchestrator down a compensation path for a booking that may exist — a refund for a
      seat the customer is holding, or a second attempt that double-books it.
    */
    expect(confirmed.outcome).toBe('AMBIGUOUS');
  });

  it('is resolved by asking the provider what it actually did', async () => {
    const qube = inventory();
    const booking = new QubeMockExternalBookingProvider(qube);
    const { show, seat } = await f10(qube);
    const reserved = await booking.createReservation({
      providerInventoryRef: show,
      selection: { inventoryType: 'SEAT', seatRefs: [seat] },
      idempotencyKey: 'wf-recover',
    });
    const reservationId = reserved.providerReservationId as string;

    // The remote system commits, and the response is lost on the wire.
    await booking.confirmReservation({
      providerReservationId: reservationId,
      idempotencyKey: 'wf-recover:confirm',
    });

    const status = await booking.getBookingStatus({
      providerReservationId: reservationId,
      idempotencyKey: 'wf-recover:status',
    });
    expect(status.status).toBe('CONFIRMED');
    expect(status.providerBookingId).toBeTruthy();

    // And the recovery does not produce a second booking.
    const retry = await booking.confirmReservation({
      providerReservationId: reservationId,
      idempotencyKey: 'wf-recover:confirm',
    });
    expect(retry.providerBookingId).toBe(status.providerBookingId);
  });

  it('reports UNKNOWN rather than CONFIRMED when nothing was committed', async () => {
    // The other half of the recovery decision. Guessing "confirmed" here would issue a ticket
    // for a seat nobody holds.
    const qube = inventory();
    const booking = new QubeMockExternalBookingProvider(qube);
    const status = await booking.getBookingStatus({ idempotencyKey: 'wf-never' });
    expect(status.status).toBe('UNKNOWN');
  });
});

describe('provider outage during checkout', () => {
  it('fails the sale and never asks local inventory', async () => {
    const qube = inventory();
    const local = new WouldSellAnything();
    const resolver = resolverWith(qube, local);
    qube.setOutage('unavailable');

    await expect(
      resolver.withFailover(
        { experienceType: 'MOVIE', eventSessionId: 'x', preferredProvider: 'qube_mock' },
        (p) =>
          p.availability({ experienceType: 'MOVIE', eventSessionId: 'x', ticketTypeIds: ['tt'] }),
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_PROVIDER_UNAVAILABLE' });

    expect(local.wasCalled).toBe(false);
  });

  it('the booking seam refuses too, rather than reserving nothing and reporting success', async () => {
    const qube = inventory();
    const booking = new QubeMockExternalBookingProvider(qube);
    const { show, seat } = await f10(qube);
    qube.setOutage('unavailable');

    const res = await booking.createReservation({
      providerInventoryRef: show,
      selection: { inventoryType: 'SEAT', seatRefs: [seat] },
      idempotencyKey: 'wf-down',
    });
    expect(res.outcome).toBe('RETRYABLE');
    expect(res.providerReservationId).toBeUndefined();
  });
});

describe('reserved seating requires a seat-capable provider', () => {
  /** A REMOTE provider that can only count — a mirrored GA feed, or a POS without seat APIs. */
  class CountsOnly implements InventoryProvider {
    readonly name = 'counts-only';
    readonly sourceKind = 'AGGREGATOR' as const;
    readonly capabilities = { search: false, authority: 'REMOTE' as const, failover: false };
    async search() {
      return [];
    }
    async availability() {
      return { unitsByTicketType: { tt: 120 }, asOf: new Date(), authority: 'REMOTE' as const };
    }
    async lockInventory() {
      return { lockRef: 'r', expiresAt: new Date(), authority: 'REMOTE' as const };
    }
    async confirmBooking() {
      return { confirmationRef: 'r', tickets: [] };
    }
    async cancelBooking() {}
    async refund() {}
    async sync() {
      return { itemsReconciled: 0, authority: 'REMOTE' as const };
    }
    async health() {
      return { healthy: true, checkedAt: new Date() };
    }
  }

  it('fails fast for a seated show when the provider cannot report seats', () => {
    /*
      The degradation this exists to stop: the provider answers "120 available", the seat
      picker has nothing to draw, and the sale either proceeds against a count — selling a seat
      the venue may already have sold — or the customer meets an empty room. Both silent.
    */
    const provider = new CountsOnly();
    expect(needsSeatLevelInventory({ seatBased: true })).toBe(true);
    expect(() => requireSeatMapCapability(provider, { eventSessionId: 'sess-1' })).toThrow(
      /reserved seating/i,
    );
    try {
      requireSeatMapCapability(provider);
    } catch (e) {
      expect((e as { code?: string }).code).toBe('INVENTORY_SOURCE_UNSUPPORTED');
    }
  });

  it('permits a seated show when the provider CAN report seats', () => {
    expect(() => requireSeatMapCapability(inventory(), { eventSessionId: 'sess-1' })).not.toThrow();
  });

  it('leaves general admission alone — a counting provider is fine there', () => {
    // The reason this is a guard on the PAIRING rather than a method on the base contract:
    // a GA provider is not deficient, it is answering a different question correctly.
    expect(needsSeatLevelInventory({ seatBased: false })).toBe(false);
    expect(needsSeatLevelInventory({})).toBe(false);
  });
});
