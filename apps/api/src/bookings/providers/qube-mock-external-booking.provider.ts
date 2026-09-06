import { Injectable } from '@nestjs/common';
import { QubeMockInventoryProvider } from '../../inventory/sourcing/providers/qube/qube-mock.provider';
import { QUBE_MOCK_PROVIDER_CODE } from '../../inventory/sourcing/providers/qube/qube-mock.fixture';
import type {
  ExternalAvailabilityRequest,
  ExternalAvailabilityResult,
  ExternalBookingProvider,
  ExternalBookingProviderCapabilities,
  ExternalBookingProviderHealth,
  ExternalBookingStatusRequest,
  ExternalBookingStatusResult,
  ExternalCancellationRequest,
  ExternalCancellationResult,
  ExternalConfirmationRequest,
  ExternalConfirmationResult,
  ExternalReservationRequest,
  ExternalReservationResult,
} from './external-booking-provider.interface';

/**
 * The Qube sandbox as the BOOKING orchestrator sees it.
 *
 * ── WHY THIS EXISTS ALONGSIDE `QubeMockInventoryProvider` ──────────────────────────
 * This codebase has two provider seams and they are not redundant:
 *
 *   `InventoryProvider`        (ADR-037) — who OWNS the stock: authority, availability,
 *                                          failover eligibility, sync
 *   `ExternalBookingProvider`  (ADR-042) — the remote booking LIFECYCLE: reserve, confirm,
 *                                          cancel, status, refund
 *
 * The orchestrator uses the first to decide that a show is provider-authoritative and must not
 * be failed over, and the second to actually run the reservation through payment to
 * confirmation. Neither subsumes the other: a source can own inventory without exposing a
 * booking lifecycle (a mirrored feed), and a booking lifecycle is meaningless for stock we own.
 *
 * ── WHY IT DELEGATES RATHER THAN KEEPING ITS OWN STATE ─────────────────────────────
 * Both seams describe the SAME remote cinema. If this adapter held its own seats, the seat map
 * a customer picked from and the seat the orchestrator reserved would be two different rooms
 * that agree only by luck — and the first thing to diverge would be a double sale that no test
 * could reproduce. There is one Qube sandbox; this is a second view onto it.
 *
 * ── STILL NOT QUBE ─────────────────────────────────────────────────────────────────
 * Invented in full, like everything else in this sandbox. The real adapter's shape depends on
 * answers we do not have — above all whether Qube has holds at all, and whether a booking can
 * be looked up after a timeout.
 */
@Injectable()
export class QubeMockExternalBookingProvider implements ExternalBookingProvider {
  readonly providerCode = QUBE_MOCK_PROVIDER_CODE;

  constructor(private readonly inventory: QubeMockInventoryProvider) {}

  /**
   * Declared honestly, because the orchestrator branches on every one of these.
   *
   * `idempotentReservation` and `idempotentConfirmation` are the two that decide whether a
   * retry is safe. Claiming them falsely would let the orchestrator retry into a double
   * booking — which is why the readiness document asks Qube for them explicitly rather than
   * assuming a modern API has them.
   */
  capabilities(): ExternalBookingProviderCapabilities {
    return {
      supportsAvailabilityCheck: true,
      supportsTemporaryReservation: true,
      supportsReservationRenewal: false,
      supportsConfirm: true,
      supportsCancel: true,
      // The capability that makes an ambiguous timeout recoverable rather than a guess.
      supportsStatusQuery: true,
      supportsRefund: true,
      requiresPaymentBeforeReservation: false,
      requiresPaymentBeforeConfirmation: true,
      supportsAuthorizeThenCapture: false,
      reservationTtlSeconds: 300,
      idempotentReservation: true,
      idempotentConfirmation: true,
      idempotentCancellation: true,
    };
  }

  /**
   * The workflow's stable key is what makes a retry return the same reservation.
   *
   * The inventory provider keys its holds on a booking id; the orchestrator speaks in
   * idempotency keys. Deriving one from the other in a single place keeps "the same request"
   * meaning the same thing on both sides of the seam.
   */
  private bookingIdFor(idempotencyKey: string): string {
    return `qbwf-${idempotencyKey}`;
  }

  /**
   * The RESERVATION reference is the identity for everything after the reservation.
   *
   * Confirm, cancel and status all carry the reservation id and each has its OWN idempotency
   * key — `…:confirm`, `…:cancel`, `…:status`. Deriving the hold from the key therefore looked
   * up a hold that had never existed, and confirmation came back NOT_FOUND for every booking
   * that had reserved perfectly. That is not a mock detail: it is what "which request key
   * identifies the booking" means in any real integration, and the answer is the reference the
   * provider gave us, not the one we invented for this call.
   */
  private bookingIdFromReservation(providerReservationId: string): string {
    return providerReservationId.replace(/^QBHOLD-/, '');
  }

  async checkAvailability(req: ExternalAvailabilityRequest): Promise<ExternalAvailabilityResult> {
    try {
      const seatRefs = req.selection.seatRefs ?? [];
      const map = await this.inventory.getSeatMap(req.providerInventoryRef);
      if (seatRefs.length > 0) {
        const available = seatRefs.every(
          (id) => map.seats.find((s) => s.externalId === id)?.state === 'AVAILABLE',
        );
        return { outcome: available ? 'OK' : 'SOLD_OUT', available };
      }
      const free = map.seats.filter((s) => s.state === 'AVAILABLE' && s.kind === 'SEAT').length;
      const enough = free >= (req.selection.quantity ?? 1);
      return { outcome: enough ? 'OK' : 'SOLD_OUT', available: enough };
    } catch (err) {
      return { outcome: this.classify(err), available: false };
    }
  }

  async createReservation(req: ExternalReservationRequest): Promise<ExternalReservationResult> {
    try {
      const res = await this.inventory.lockInventory({
        experienceType: 'MOVIE',
        eventSessionId: req.providerInventoryRef,
        bookingId: this.bookingIdFor(req.idempotencyKey),
        lines: [
          {
            ticketTypeId: 'external',
            quantity: req.selection.seatRefs?.length ?? req.selection.quantity ?? 1,
            seatIds: req.selection.seatRefs,
          },
        ],
        holdExpiresAt: new Date(Date.now() + 300_000),
      });
      return {
        outcome: 'OK',
        providerReservationId: res.lockRef,
        reservationExpiresAt: res.expiresAt,
        providerStatus: 'RESERVED',
      };
    } catch (err) {
      return { outcome: this.classify(err), providerStatus: 'REJECTED' };
    }
  }

  async confirmReservation(req: ExternalConfirmationRequest): Promise<ExternalConfirmationResult> {
    const bookingId = this.bookingIdFromReservation(req.providerReservationId);
    try {
      const res = await this.inventory.confirmBooking({
        experienceType: 'MOVIE',
        eventSessionId: '',
        bookingId,
        lines: [{ ticketTypeId: 'external', quantity: 1 }],
      });
      return { outcome: 'OK', providerBookingId: res.confirmationRef, providerStatus: 'CONFIRMED' };
    } catch (err) {
      /*
        A timeout here is the dangerous case, and it is reported as AMBIGUOUS rather than
        RETRYABLE or REJECTED. The remote system may well have committed the booking before the
        response was lost; treating that as failure is how a seat is sold twice or a customer is
        refunded for a booking that exists. The orchestrator has a recovery path for AMBIGUOUS
        that calls `getBookingStatus` — this is what routes it there.
      */
      return { outcome: this.classify(err), providerStatus: 'UNKNOWN' };
    }
  }

  async cancelReservation(req: ExternalCancellationRequest): Promise<ExternalCancellationResult> {
    try {
      await this.inventory.cancelBooking({
        experienceType: 'MOVIE',
        eventSessionId: '',
        bookingId: this.bookingIdFromReservation(req.providerReservationId ?? ''),
        lines: [],
      });
      return { outcome: 'OK', providerStatus: 'CANCELLED' };
    } catch (err) {
      return { outcome: this.classify(err), providerStatus: 'UNKNOWN' };
    }
  }

  /**
   * What the remote system actually did — the answer an ambiguous confirmation needs.
   *
   * A provider without this cannot be integrated safely: a timed-out confirmation could only
   * be resolved by assuming, and either assumption is wrong some of the time.
   */
  async getBookingStatus(req: ExternalBookingStatusRequest): Promise<ExternalBookingStatusResult> {
    try {
      const bookingId = this.bookingIdFromReservation(req.providerReservationId ?? '');
      const found = await this.inventory.getExternalBooking(bookingId);
      return found.status === 'CONFIRMED'
        ? { outcome: 'OK', status: 'CONFIRMED', providerBookingId: found.externalBookingId }
        : { outcome: 'OK', status: 'UNKNOWN' };
    } catch (err) {
      return { outcome: this.classify(err), status: 'UNKNOWN' };
    }
  }

  async refundBooking(): Promise<{ outcome: 'OK'; providerRefundId: string }> {
    return { outcome: 'OK', providerRefundId: 'qbrf-mock' };
  }

  async health(): Promise<ExternalBookingProviderHealth> {
    const h = await this.inventory.health();
    return { healthy: h.healthy, detail: h.reason };
  }

  /**
   * Turn the inventory seam's errors into the booking seam's outcomes.
   *
   * The mapping that matters is PROVIDER_TIMEOUT → AMBIGUOUS. Everything else collapses
   * safely; that one must not, because AMBIGUOUS is the only outcome the orchestrator treats
   * as "find out what happened" rather than "it did not happen".
   */
  private classify(err: unknown): ExternalReservationResult['outcome'] {
    const code = (err as { code?: string })?.code;
    switch (code) {
      case 'PROVIDER_TIMEOUT':
        return 'AMBIGUOUS';
      case 'INVENTORY_ALREADY_SOLD':
        return 'SOLD_OUT';
      case 'INVENTORY_ALREADY_HELD':
        return 'CONFLICT';
      case 'HOLD_EXPIRED':
        return 'RESERVATION_EXPIRED';
      case 'NOT_FOUND':
        return 'NOT_FOUND';
      case 'INVENTORY_PROVIDER_UNAVAILABLE':
        return 'RETRYABLE';
      default:
        return 'REJECTED';
    }
  }
}
