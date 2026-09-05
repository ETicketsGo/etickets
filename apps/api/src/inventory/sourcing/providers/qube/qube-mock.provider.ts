import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../../../common/errors';
import type {
  AvailabilityQuery,
  AvailabilitySnapshot,
  ConfirmResult,
  InventoryProvider,
  InventoryProviderCapabilities,
  InventorySourceKind,
  InventoryWriteContext,
  LockRequest,
  LockResult,
  ProviderHealth,
  RefundInventoryRequest,
  SearchQuery,
  SearchResultItem,
  SyncRequest,
  SyncResult,
} from '../../inventory-provider.interface';
import type {
  CinemaCatalogueCapability,
  ExternalCinema,
  ExternalMovie,
  ExternalScreen,
  ExternalSeat,
  ExternalSeatMap,
  ExternalSeatState,
  ExternalShow,
  SeatMapCapability,
} from '../../cinema-capabilities.interface';
import {
  QUBE_MOCK_BLOCKED_LABELS,
  QUBE_MOCK_CATEGORIES,
  QUBE_MOCK_CINEMA,
  QUBE_MOCK_MOVIES,
  QUBE_MOCK_PRESOLD_LABELS,
  QUBE_MOCK_PROVIDER_CODE,
  QUBE_MOCK_SCREENS,
  buildSeats,
  buildShows,
} from './qube-mock.fixture';

/**
 * A remote cinema POS, simulated well enough to be wrong about.
 *
 * ── THIS IS NOT QUBE ───────────────────────────────────────────────────────────────
 * No part of this reflects Qube Cinema's real API. We have no documentation, credentials or
 * sandbox for it. Every identifier, state name, timing rule and error below is invented to
 * exercise ETicketsGo's own external-inventory architecture against a plausible remote
 * authority. `QubeProvider` is the placeholder for the real thing.
 *
 * ── WHY IT IMPLEMENTS `InventoryProvider` AND NOT A NEW CONTRACT ───────────────────
 * Because the contract already existed (ADR-037) and already says the right things: who owns
 * the stock, whether it may be failed over, how it is held, confirmed, cancelled and synced.
 * A parallel "cinema provider" hierarchy would have needed its own registry, resolver, health
 * monitor and failover rules — a second set of answers to questions this codebase has already
 * answered once, which is how two systems start disagreeing about who sold a seat.
 *
 * ── WHY IT IS STATEFUL ─────────────────────────────────────────────────────────────
 * A mock that returns the same JSON every time proves nothing. This one holds seats, expires
 * those holds, refuses a seat somebody else took, and is idempotent under retry — because
 * those are the behaviours the booking engine has to survive, and a static fixture lets every
 * one of them ship broken.
 *
 * State lives in this process, deliberately. It is standing in for a REMOTE system's database,
 * which is exactly what ETicketsGo does not own — putting it in our Postgres would quietly
 * make the "remote" authority local and let a test pass for the wrong reason.
 */
@Injectable()
export class QubeMockInventoryProvider
  implements InventoryProvider, CinemaCatalogueCapability, SeatMapCapability
{
  readonly name = QUBE_MOCK_PROVIDER_CODE;
  readonly sourceKind: InventorySourceKind = 'AGGREGATOR';

  private readonly logger = new Logger(QubeMockInventoryProvider.name);

  /**
   * ── THE MOST IMPORTANT LINE IN THIS FILE ─────────────────────────────────────────
   * `failover: false`.
   *
   * These seats belong to somebody else's system. If this provider is unreachable and the
   * resolver stepped past it to LOCAL inventory, ETicketsGo would sell seats it does not own
   * — and the customer would find out at the door, in front of a cinema that has never heard
   * of them. An outage must fail the sale, not relocate it.
   *
   * The resolver already honours this (`if (!provider.capabilities.failover) throw err`).
   * There is a test asserting an outage here does NOT reach local stock.
   */
  readonly capabilities: InventoryProviderCapabilities = {
    search: true,
    authority: 'REMOTE',
    failover: false,
  };

  /** How long the remote system says it will hold seats. Real vendors differ; ask Qube. */
  private readonly holdTtlMs = 5 * 60_000;

  /** Simulated latency and outage, for exercising timeout and failover paths in tests. */
  private latencyMs = 0;
  private outage: 'none' | 'unavailable' | 'timeout' = 'none';

  private readonly shows = buildShows();
  /** showExternalId → seat state, lazily built so an unvisited show costs nothing. */
  private readonly seatsByShow = new Map<string, ExternalSeat[]>();
  /** holdId → what it holds, so release and confirm act on the same seats. */
  private readonly holds = new Map<
    string,
    { showExternalId: string; seatExternalIds: string[]; expiresAt: number; confirmed?: string }
  >();
  /** idempotencyKey → holdId / bookingId, so a retry returns the first answer. */
  private readonly idempotency = new Map<string, string>();

  /* ── test/ops controls ─────────────────────────────────────────────────────────── */

  /** Simulate the vendor being down or slow. Test-only; never driven by request input. */
  setOutage(mode: 'none' | 'unavailable' | 'timeout', latencyMs = 0): void {
    this.outage = mode;
    this.latencyMs = latencyMs;
  }

  /** Wind every live hold into the past, to exercise expiry without waiting five minutes. */
  expireAllHolds(): void {
    for (const hold of this.holds.values()) hold.expiresAt = 0;
  }

  reset(): void {
    this.seatsByShow.clear();
    this.holds.clear();
    this.idempotency.clear();
    this.outage = 'none';
    this.latencyMs = 0;
  }

  /* ── the remote system's own behaviour ─────────────────────────────────────────── */

  /**
   * Every call goes through here, because a real integration's failure modes are the point.
   *
   * A timeout is NOT reported as a failure. It is reported as an unknown outcome, which is a
   * different thing and the single most important distinction in an external POS integration:
   * a request that timed out may well have succeeded at the far end, and treating it as failed
   * is how a seat is sold twice or a customer is refunded for a booking that exists.
   */
  private async transport<T>(op: string, fn: () => T): Promise<T> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.outage === 'unavailable') {
      throw new AppException(
        ErrorCodes.INVENTORY_PROVIDER_UNAVAILABLE,
        `${this.name} is unavailable (${op}).`,
        HttpStatus.SERVICE_UNAVAILABLE,
        { provider: this.name, op },
      );
    }
    if (this.outage === 'timeout') {
      throw new AppException(
        ErrorCodes.PROVIDER_TIMEOUT,
        `${this.name} did not respond in time (${op}). The outcome is UNKNOWN — do not assume it failed.`,
        HttpStatus.GATEWAY_TIMEOUT,
        { provider: this.name, op, outcome: 'UNKNOWN' },
      );
    }
    return fn();
  }

  private seatsFor(showExternalId: string): ExternalSeat[] {
    let seats = this.seatsByShow.get(showExternalId);
    if (!seats) {
      seats = buildSeats(showExternalId).map((s) => ({
        ...s,
        state: QUBE_MOCK_BLOCKED_LABELS.includes(s.label)
          ? ('BLOCKED' as ExternalSeatState)
          : QUBE_MOCK_PRESOLD_LABELS.includes(s.label)
            ? ('SOLD' as ExternalSeatState)
            : ('AVAILABLE' as ExternalSeatState),
      }));
      this.seatsByShow.set(showExternalId, seats);
    }
    // Expire lapsed holds before answering anything. A remote system does this on its own
    // clock, and a caller that never asked would otherwise see a seat held forever.
    this.releaseExpired();
    return seats;
  }

  private releaseExpired(): void {
    const now = Date.now();
    for (const [holdId, hold] of this.holds) {
      if (hold.confirmed || hold.expiresAt > now) continue;
      const seats = this.seatsByShow.get(hold.showExternalId);
      for (const id of hold.seatExternalIds) {
        const seat = seats?.find((s) => s.externalId === id);
        if (seat?.state === 'HELD') seat.state = 'AVAILABLE';
      }
      this.holds.delete(holdId);
    }
  }

  /* ── CinemaCatalogueCapability ─────────────────────────────────────────────────── */

  async getCinemas(): Promise<ExternalCinema[]> {
    return this.transport('getCinemas', () => [QUBE_MOCK_CINEMA]);
  }

  async getScreens(cinemaExternalId?: string): Promise<ExternalScreen[]> {
    return this.transport('getScreens', () =>
      QUBE_MOCK_SCREENS.filter((s) => !cinemaExternalId || s.cinemaExternalId === cinemaExternalId),
    );
  }

  async getMovies(): Promise<ExternalMovie[]> {
    return this.transport('getMovies', () => QUBE_MOCK_MOVIES);
  }

  async getShows(params: {
    cinemaExternalId?: string;
    movieExternalId?: string;
    date?: string;
  }): Promise<ExternalShow[]> {
    return this.transport('getShows', () =>
      this.shows.filter((s) => {
        if (params.cinemaExternalId && s.cinemaExternalId !== params.cinemaExternalId) return false;
        if (params.movieExternalId && s.movieExternalId !== params.movieExternalId) return false;
        if (params.date) {
          // Compared in the CINEMA's zone. "Shows on the 8th" means the cinema's 8th, and
          // filtering on a UTC date drops the late show or adds tomorrow's first.
          const local = new Intl.DateTimeFormat('en-CA', {
            timeZone: QUBE_MOCK_CINEMA.timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(s.startsAt);
          if (local !== params.date) return false;
        }
        return true;
      }),
    );
  }

  /* ── SeatMapCapability ─────────────────────────────────────────────────────────── */

  async getSeatMap(showExternalId: string): Promise<ExternalSeatMap> {
    return this.transport('getSeatMap', () => {
      this.assertShowExists(showExternalId);
      return {
        showExternalId,
        categories: QUBE_MOCK_CATEGORIES,
        seats: this.seatsFor(showExternalId).map((s) => ({ ...s })),
        asOf: new Date(),
      };
    });
  }

  private assertShowExists(showExternalId: string): void {
    if (!this.shows.some((s) => s.externalId === showExternalId)) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        `Unknown show ${showExternalId} at ${this.name}.`,
        HttpStatus.NOT_FOUND,
        { provider: this.name },
      );
    }
  }

  /* ── InventoryProvider ─────────────────────────────────────────────────────────── */

  async search(query: SearchQuery): Promise<SearchResultItem[]> {
    return this.transport('search', () => {
      const text = query.text?.trim().toLowerCase();
      const byId = new Map(QUBE_MOCK_MOVIES.map((m) => [m.externalId, m]));
      return this.shows
        .filter((s) => {
          if (query.from && s.startsAt < query.from) return false;
          if (query.to && s.startsAt > query.to) return false;
          if (!text) return true;
          return (byId.get(s.movieExternalId)?.title ?? '').toLowerCase().includes(text);
        })
        .slice(0, query.limit ?? 50)
        .map((s) => ({
          externalId: s.externalId,
          experienceType: 'MOVIE' as const,
          title: byId.get(s.movieExternalId)?.title ?? s.movieExternalId,
          startsAt: s.startsAt,
          venueName: QUBE_MOCK_CINEMA.name,
        }));
    });
  }

  /**
   * How many seats the remote system says are free.
   *
   * Reported per ticket type as the contract requires, and keyed on the SHOW, because for a
   * provider-authoritative cinema the remote system is the only thing that knows. The snapshot
   * is stamped `REMOTE` so callers know it may already be stale — which it always is.
   */
  async availability(query: AvailabilityQuery): Promise<AvailabilitySnapshot> {
    return this.transport('availability', () => {
      const showExternalId = this.externalShowFor(query.eventSessionId);
      const seats = this.seatsFor(showExternalId);
      const free = seats.filter((s) => s.state === 'AVAILABLE' && s.kind !== 'GAP').length;
      const unitsByTicketType: Record<string, number> = {};
      for (const id of query.ticketTypeIds) unitsByTicketType[id] = free;
      return { unitsByTicketType, asOf: new Date(), authority: 'REMOTE' as const };
    });
  }

  /**
   * Hold seats at the remote system.
   *
   * Idempotent on `bookingId`: a retry of the same request returns the SAME hold rather than
   * taking a second set of seats. Without that, a network blip during checkout quietly holds
   * the room twice and the customer is told their seats are gone by a hold they own.
   */
  async lockInventory(req: LockRequest): Promise<LockResult> {
    return this.transport('lockInventory', () => {
      const showExternalId = this.externalShowFor(req.eventSessionId);
      const idemKey = `lock:${req.bookingId}`;
      const existing = this.idempotency.get(idemKey);
      if (existing) {
        const hold = this.holds.get(existing);
        if (hold)
          return {
            lockRef: existing,
            expiresAt: new Date(hold.expiresAt),
            authority: 'REMOTE' as const,
          };
      }

      const wanted = this.requestedSeats(req, showExternalId);
      const seats = this.seatsFor(showExternalId);

      /*
        Check every seat BEFORE taking any. A partial hold leaves the customer owning three of
        the four seats they asked for and no way to say so — and the fourth is gone by the time
        anyone notices.
      */
      for (const seatId of wanted) {
        const seat = seats.find((s) => s.externalId === seatId);
        if (!seat) {
          throw new AppException(
            ErrorCodes.NOT_FOUND,
            `Seat ${seatId} is not part of show ${showExternalId}.`,
            HttpStatus.NOT_FOUND,
            { provider: this.name },
          );
        }
        if (seat.state === 'SOLD') {
          throw new AppException(
            ErrorCodes.INVENTORY_ALREADY_SOLD,
            `Seat ${seat.label} has already been sold at the venue.`,
            HttpStatus.CONFLICT,
            { provider: this.name, seat: seat.label },
          );
        }
        if (seat.state === 'HELD') {
          throw new AppException(
            ErrorCodes.INVENTORY_ALREADY_HELD,
            `Seat ${seat.label} is held by another customer.`,
            HttpStatus.CONFLICT,
            { provider: this.name, seat: seat.label },
          );
        }
        if (seat.state === 'BLOCKED' || seat.kind === 'GAP') {
          throw new AppException(
            ErrorCodes.BOOKING_INVENTORY_UNAVAILABLE,
            `Seat ${seat.label} is not on sale.`,
            HttpStatus.CONFLICT,
            { provider: this.name, seat: seat.label },
          );
        }
      }

      const holdId = `QBHOLD-${req.bookingId}`;
      const expiresAt = Math.min(req.holdExpiresAt.getTime(), Date.now() + this.holdTtlMs);
      for (const seatId of wanted) {
        const seat = seats.find((s) => s.externalId === seatId)!;
        seat.state = 'HELD';
      }
      this.holds.set(holdId, { showExternalId, seatExternalIds: wanted, expiresAt });
      this.idempotency.set(idemKey, holdId);
      return { lockRef: holdId, expiresAt: new Date(expiresAt), authority: 'REMOTE' as const };
    });
  }

  /**
   * Turn a hold into a booking at the remote system.
   *
   * Refuses an expired hold rather than quietly re-taking the seats: by then somebody else may
   * hold them, and "confirm anyway" is how two customers get the same seat.
   */
  async confirmBooking(ctx: InventoryWriteContext): Promise<ConfirmResult> {
    return this.transport('confirmBooking', () => {
      const holdId = `QBHOLD-${ctx.bookingId}`;
      const idemKey = `confirm:${ctx.bookingId}`;
      const already = this.idempotency.get(idemKey);
      if (already) {
        // A retry of a confirmation that already succeeded returns the same booking. This is
        // what makes recovery from an ambiguous timeout safe.
        return { confirmationRef: already, tickets: this.ticketsFor(ctx) };
      }

      const hold = this.holds.get(holdId);
      if (!hold) {
        throw new AppException(
          ErrorCodes.HOLD_EXPIRED,
          `Hold ${holdId} is gone — it expired or was released. The seats must be taken again.`,
          HttpStatus.CONFLICT,
          { provider: this.name },
        );
      }
      if (hold.expiresAt <= Date.now()) {
        this.releaseExpired();
        throw new AppException(
          ErrorCodes.HOLD_EXPIRED,
          `Hold ${holdId} expired before confirmation.`,
          HttpStatus.CONFLICT,
          { provider: this.name },
        );
      }

      const seats = this.seatsFor(hold.showExternalId);
      for (const id of hold.seatExternalIds) {
        const seat = seats.find((s) => s.externalId === id);
        if (seat) seat.state = 'SOLD';
      }
      const externalBookingId = `QBBK-${ctx.bookingId}`;
      hold.confirmed = externalBookingId;
      this.idempotency.set(idemKey, externalBookingId);
      return { confirmationRef: externalBookingId, tickets: this.ticketsFor(ctx) };
    });
  }

  async cancelBooking(ctx: InventoryWriteContext): Promise<void> {
    await this.transport('cancelBooking', () => {
      const holdId = `QBHOLD-${ctx.bookingId}`;
      const hold = this.holds.get(holdId);
      if (!hold) return; // Nothing held and nothing booked: cancelling is already true.
      const seats = this.seatsFor(hold.showExternalId);
      for (const id of hold.seatExternalIds) {
        const seat = seats.find((s) => s.externalId === id);
        if (seat && (seat.state === 'HELD' || seat.state === 'SOLD')) seat.state = 'AVAILABLE';
      }
      this.holds.delete(holdId);
      this.idempotency.delete(`lock:${ctx.bookingId}`);
      this.idempotency.delete(`confirm:${ctx.bookingId}`);
    });
  }

  async refund(req: RefundInventoryRequest): Promise<void> {
    // Returning the seats IS the inventory side of a refund; the money is the payment
    // domain's business and is not this provider's to touch.
    await this.cancelBooking({
      experienceType: req.experienceType,
      eventSessionId: req.eventSessionId,
      bookingId: req.bookingId,
      lines: [],
    });
  }

  /**
   * What the remote system currently believes about a booking.
   *
   * The recovery path for an ambiguous timeout: when confirmation neither succeeded nor
   * failed, this is how the truth is established rather than guessed.
   */
  async getExternalBooking(
    bookingId: string,
  ): Promise<{ externalBookingId: string; status: 'CONFIRMED' | 'NOT_FOUND' }> {
    return this.transport('getExternalBooking', () => {
      const ref = this.idempotency.get(`confirm:${bookingId}`);
      return ref
        ? { externalBookingId: ref, status: 'CONFIRMED' as const }
        : { externalBookingId: '', status: 'NOT_FOUND' as const };
    });
  }

  async sync(req: SyncRequest): Promise<SyncResult> {
    return this.transport('sync', () => {
      const scoped = req.eventSessionId ? 1 : this.shows.length;
      this.logger.log(`${this.name} sync (${req.reason ?? 'MANUAL'}): ${scoped} show(s)`);
      return { itemsReconciled: scoped, authority: 'REMOTE' as const };
    });
  }

  async health(): Promise<ProviderHealth> {
    if (this.outage !== 'none') {
      return { healthy: false, reason: `simulated-${this.outage}`, checkedAt: new Date() };
    }
    return { healthy: true, checkedAt: new Date() };
  }

  /* ── helpers ───────────────────────────────────────────────────────────────────── */

  /**
   * Which remote show an ETicketsGo session corresponds to.
   *
   * In the real integration this is a `ProviderMapping` lookup. The mock accepts either a
   * mapped external id passed straight through, or falls back to the first show, so a test
   * can exercise the provider without standing up the whole mapping table.
   */
  private externalShowFor(eventSessionId: string): string {
    if (this.shows.some((s) => s.externalId === eventSessionId)) return eventSessionId;
    return this.shows[0].externalId;
  }

  /** Seat ids the caller asked for, or the first free seats when it asked only for units. */
  private requestedSeats(req: LockRequest, showExternalId: string): string[] {
    const explicit = req.lines.flatMap((l) => l.seatIds ?? []);
    if (explicit.length > 0) return explicit;
    const units = req.lines.reduce((n, l) => n + l.quantity, 0);
    return this.seatsFor(showExternalId)
      .filter((s) => s.state === 'AVAILABLE' && s.kind === 'SEAT')
      .slice(0, units)
      .map((s) => s.externalId);
  }

  private ticketsFor(ctx: InventoryWriteContext): ConfirmResult['tickets'] {
    const hold = this.holds.get(`QBHOLD-${ctx.bookingId}`);
    const seats = hold ? this.seatsFor(hold.showExternalId) : [];
    return (hold?.seatExternalIds ?? []).map((id, i) => ({
      ticketTypeId: ctx.lines[Math.min(i, Math.max(0, ctx.lines.length - 1))]?.ticketTypeId ?? '',
      seatLabel: seats.find((s) => s.externalId === id)?.label,
    }));
  }
}
