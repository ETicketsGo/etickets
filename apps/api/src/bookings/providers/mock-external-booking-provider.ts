import { Injectable } from '@nestjs/common';
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
 * DEV/TEST-ONLY external booking provider (ADR-042 §8, P5.2B). It behaves as a real external
 * boundary (idempotent reservation/confirmation, TTL, status query, failure/latency/ambiguity
 * simulation) so the orchestrator can be exercised against every provider-authoritative path
 * WITHOUT a real vendor. It is deliberately NOT named after any real provider, is never
 * production-ready, and is only constructed behind `BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED`
 * (startup validation rejects it in production). Scenarios are DETERMINISTIC — encoded in the
 * provider inventory ref via a `#scenario` suffix — so tests never rely on randomness:
 *
 *   `#soldout`      → reservation returns SOLD_OUT
 *   `#reject`       → reservation returns REJECTED
 *   `#timeout`      → reservation/confirmation returns AMBIGUOUS (lost response)
 *   `#confirmlost`  → provider CONFIRMS internally but the confirm response is AMBIGUOUS;
 *                     a later status query reports CONFIRMED (provider-confirmed-response-lost)
 *   `#expire`       → the reservation is issued already expired
 *   `#pricechange`  → reservation quotes a different amount than requested
 *   (default)       → happy path
 */
@Injectable()
export class MockExternalBookingProvider implements ExternalBookingProvider {
  readonly providerCode = 'mock-external-booking';
  private readonly reservations = new Map<
    string,
    { id: string; status: 'RESERVED' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED'; expiresAt: Date }
  >();
  private readonly ttlSeconds = 300;

  capabilities(): ExternalBookingProviderCapabilities {
    return {
      supportsAvailabilityCheck: true,
      supportsTemporaryReservation: true,
      supportsReservationRenewal: false,
      supportsConfirm: true,
      supportsCancel: true,
      supportsStatusQuery: true,
      supportsRefund: false,
      requiresPaymentBeforeReservation: false,
      requiresPaymentBeforeConfirmation: true,
      supportsAuthorizeThenCapture: false,
      reservationTtlSeconds: this.ttlSeconds,
      idempotentReservation: true,
      idempotentConfirmation: true,
      idempotentCancellation: true,
    };
  }

  private scenario(ref: string): string {
    const i = ref.indexOf('#');
    return i >= 0 ? ref.slice(i + 1) : '';
  }

  async checkAvailability(req: ExternalAvailabilityRequest): Promise<ExternalAvailabilityResult> {
    const s = this.scenario(req.providerInventoryRef);
    if (s === 'soldout') return { outcome: 'SOLD_OUT', available: false };
    return { outcome: 'OK', available: true };
  }

  async createReservation(req: ExternalReservationRequest): Promise<ExternalReservationResult> {
    // Idempotent: the same key always returns the same reservation.
    const existing = this.reservations.get(req.idempotencyKey);
    if (existing) {
      return {
        outcome: 'OK',
        providerReservationId: existing.id,
        reservationExpiresAt: existing.expiresAt,
        providerStatus: existing.status,
      };
    }
    const s = this.scenario(req.providerInventoryRef);
    if (s === 'soldout') return { outcome: 'SOLD_OUT' };
    if (s === 'reject') return { outcome: 'REJECTED' };
    if (s === 'timeout') return { outcome: 'AMBIGUOUS' }; // response lost; no reservation persisted
    const id = `mockres_${this.hash(req.idempotencyKey)}`;
    const expiresAt = new Date(Date.now() + (s === 'expire' ? -1000 : this.ttlSeconds * 1000));
    this.reservations.set(req.idempotencyKey, { id, status: 'RESERVED', expiresAt });
    const amountMinor =
      s === 'pricechange' && req.expectedAmountMinor
        ? req.expectedAmountMinor + 100
        : req.expectedAmountMinor;
    return {
      outcome: 'OK',
      providerReservationId: id,
      reservationExpiresAt: expiresAt,
      amountMinor,
      currency: req.currency,
      providerStatus: 'RESERVED',
    };
  }

  async confirmReservation(req: ExternalConfirmationRequest): Promise<ExternalConfirmationResult> {
    const entry = [...this.reservations.entries()].find(
      ([, r]) => r.id === req.providerReservationId,
    );
    if (!entry) return { outcome: 'NOT_FOUND' };
    const [, r] = entry;
    if (r.status === 'EXPIRED' || r.expiresAt.getTime() < Date.now()) {
      r.status = 'EXPIRED';
      return { outcome: 'RESERVATION_EXPIRED' };
    }
    if (r.status === 'CONFIRMED') {
      // Idempotent replay.
      return { outcome: 'OK', providerBookingId: `mockbk_${r.id}`, providerStatus: 'CONFIRMED' };
    }
    // provider-confirmed-but-response-lost: mark confirmed internally, return AMBIGUOUS so the
    // orchestrator must recover via a status query.
    const lost = req.providerReservationId?.includes('confirmlost');
    r.status = 'CONFIRMED';
    if (lost) return { outcome: 'AMBIGUOUS' };
    return { outcome: 'OK', providerBookingId: `mockbk_${r.id}`, providerStatus: 'CONFIRMED' };
  }

  async cancelReservation(req: ExternalCancellationRequest): Promise<ExternalCancellationResult> {
    const entry = [...this.reservations.entries()].find(
      ([, r]) => r.id === req.providerReservationId,
    );
    if (entry) entry[1].status = 'CANCELLED';
    return { outcome: 'OK', providerStatus: 'CANCELLED' }; // idempotent
  }

  async getBookingStatus(req: ExternalBookingStatusRequest): Promise<ExternalBookingStatusResult> {
    const entry = [...this.reservations.entries()].find(
      ([, r]) => r.id === req.providerReservationId,
    );
    if (!entry) return { outcome: 'NOT_FOUND', status: 'UNKNOWN' };
    const [, r] = entry;
    return {
      outcome: 'OK',
      status: r.status,
      providerBookingId: r.status === 'CONFIRMED' ? `mockbk_${r.id}` : undefined,
    };
  }

  async health(): Promise<ExternalBookingProviderHealth> {
    return { healthy: true, detail: 'mock' };
  }

  /** Test hook: force a reservation into a state (never exposed to production paths). */
  __setReservationState(
    idempotencyKey: string,
    status: 'RESERVED' | 'CONFIRMED' | 'EXPIRED',
  ): void {
    const r = this.reservations.get(idempotencyKey);
    if (r) r.status = status;
  }

  private hash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16);
  }
}
