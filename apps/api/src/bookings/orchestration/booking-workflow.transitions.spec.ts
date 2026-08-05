import { BookingWorkflowState as S, isTerminal, TERMINAL_STATES } from './booking-workflow-state';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
} from './booking-workflow.transitions';
import { InvalidBookingTransitionError } from './booking-orchestrator.errors';

describe('booking workflow transitions', () => {
  it('allows the local-authoritative happy path', () => {
    const path = [
      S.DRAFT,
      S.INVENTORY_RESOLVED,
      S.LOCK_PENDING,
      S.LOCKED,
      S.PAYMENT_PENDING,
      S.PAYMENT_AUTHORIZED,
      S.CONFIRMING,
      S.CONFIRMED,
      S.TICKET_PENDING,
      S.TICKET_ISSUED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('allows the provider-authoritative confirmation path', () => {
    expect(canTransition(S.PAYMENT_AUTHORIZED, S.PROVIDER_CONFIRM_PENDING)).toBe(true);
    expect(canTransition(S.PROVIDER_CONFIRM_PENDING, S.PROVIDER_CONFIRMED)).toBe(true);
    expect(canTransition(S.PROVIDER_CONFIRMED, S.CONFIRMING)).toBe(true);
  });

  it('treats re-asserting the same state as an idempotent no-op', () => {
    expect(canTransition(S.LOCKED, S.LOCKED)).toBe(true);
    expect(() => assertTransition(S.CONFIRMED, S.CONFIRMED)).not.toThrow();
  });

  it('rejects illegal jumps (e.g. DRAFT → CONFIRMED, LOCKED → REFUNDED)', () => {
    expect(canTransition(S.DRAFT, S.CONFIRMED)).toBe(false);
    expect(() => assertTransition(S.DRAFT, S.CONFIRMED)).toThrow(InvalidBookingTransitionError);
    expect(() => assertTransition(S.LOCKED, S.REFUNDED)).toThrow(InvalidBookingTransitionError);
  });

  it('rejects any outgoing transition from a terminal state', () => {
    for (const t of TERMINAL_STATES) {
      expect(ALLOWED_TRANSITIONS[t].size).toBe(0);
      expect(() => assertTransition(t, S.CONFIRMING)).toThrow(InvalidBookingTransitionError);
      expect(isTerminal(t)).toBe(true);
    }
  });

  it('supports compensation from money/inventory/provider-dirty states', () => {
    for (const from of [
      S.LOCKED,
      S.PAYMENT_PENDING,
      S.PAYMENT_AUTHORIZED,
      S.PROVIDER_CONFIRM_PENDING,
      S.PROVIDER_CONFIRMED,
      S.CONFIRMING,
    ]) {
      expect(canTransition(from, S.COMPENSATION_PENDING)).toBe(true);
    }
    expect(canTransition(S.COMPENSATION_PENDING, S.COMPENSATED)).toBe(true);
  });

  it('models post-sale refund/cancel from a booked+ticketed booking', () => {
    expect(canTransition(S.TICKET_ISSUED, S.CANCELLATION_PENDING)).toBe(true);
    expect(canTransition(S.TICKET_ISSUED, S.REFUND_PENDING)).toBe(true);
    expect(canTransition(S.CANCELLATION_PENDING, S.REFUND_PENDING)).toBe(true);
    expect(canTransition(S.REFUND_PENDING, S.REFUNDED)).toBe(true);
  });

  it('routes a paid booking to refund, never straight to CANCELLED after payment', () => {
    // From PAID states cancellation must go through the refund path, not direct CANCELLED.
    expect(canTransition(S.PAYMENT_AUTHORIZED, S.CANCELLED)).toBe(false);
    expect(canTransition(S.PAYMENT_AUTHORIZED, S.CANCELLATION_PENDING)).toBe(true);
  });

  it('models the provider-authoritative reservation sequence (P5.2B S3)', () => {
    expect(canTransition(S.LOCKED, S.PROVIDER_RESERVATION_PENDING)).toBe(true);
    expect(canTransition(S.PROVIDER_RESERVATION_PENDING, S.PROVIDER_RESERVED)).toBe(true);
    expect(canTransition(S.PROVIDER_RESERVED, S.PAYMENT_PENDING)).toBe(true);
    expect(canTransition(S.PAYMENT_AUTHORIZED, S.PROVIDER_CONFIRM_PENDING)).toBe(true);
    expect(canTransition(S.PROVIDER_CONFIRM_PENDING, S.PROVIDER_CONFIRMED)).toBe(true);
    expect(canTransition(S.PROVIDER_CONFIRMED, S.CONFIRMING)).toBe(true);
    // Reservation can expire or be compensated; it cannot jump straight to CONFIRMED.
    expect(canTransition(S.PROVIDER_RESERVATION_PENDING, S.EXPIRING)).toBe(true);
    expect(canTransition(S.PROVIDER_CONFIRM_PENDING, S.COMPENSATION_PENDING)).toBe(true);
    expect(canTransition(S.PROVIDER_RESERVED, S.CONFIRMED)).toBe(false);
    expect(canTransition(S.PROVIDER_RESERVATION_PENDING, S.CONFIRMED)).toBe(false);
  });

  it('every non-terminal state has at least one outgoing transition (no dead ends)', () => {
    for (const s of Object.values(S)) {
      if (!isTerminal(s)) expect(ALLOWED_TRANSITIONS[s].size).toBeGreaterThan(0);
    }
  });
});
