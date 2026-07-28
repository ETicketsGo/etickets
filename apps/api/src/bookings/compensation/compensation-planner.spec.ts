import { CompensationPlanner, type CompensationContext } from './compensation-planner';
import { CompensationType } from './compensation-types';

const planner = new CompensationPlanner();
const base = (over: Partial<CompensationContext> = {}): CompensationContext => ({
  bookingId: 'b1',
  reasonCode: 'X',
  ...over,
});
describe('CompensationPlanner — deterministic cases A–H', () => {
  it('A. Redis lock ok, local hold failed (pre-payment) → REDIS_LOCK_RELEASE (auto-safe)', () => {
    const plan = planner.plan(
      base({ redisLockPresent: true, localHoldActive: false, paymentSucceeded: false }),
    );
    expect(plan.actions.map((a) => a.compensationType)).toEqual([
      CompensationType.REDIS_LOCK_RELEASE,
    ]);
    expect(plan.autoExecutable).toBe(true);
    expect(plan.requiresManualReview).toBe(false);
  });

  it('B. Local hold ok, payment create permanently failed → hold release (+reservation cancel)', () => {
    const plan = planner.plan(
      base({ paymentCreatePermanentlyFailed: true, providerReservationId: 'r1' }),
    );
    expect(plan.actions.map((a) => a.compensationType)).toEqual([
      CompensationType.LOCAL_HOLD_RELEASE,
      CompensationType.PROVIDER_RESERVATION_CANCEL,
    ]);
  });

  it('C. Payment succeeded, provider rejected → refund/void planned but NOT auto-executable', () => {
    const plan = planner.plan(
      base({
        paymentSucceeded: true,
        providerOutcome: 'REJECTED',
        payment: { captured: true },
        paymentCapabilities: { supportsAuthorizeCapture: false, supportsRefund: true },
        providerReservationId: 'r1',
        redisLockPresent: true,
      }),
    );
    const t = plan.actions.map((a) => a.compensationType);
    expect(t).toContain(CompensationType.PAYMENT_REFUND);
    expect(t).toContain(CompensationType.LOCAL_HOLD_RELEASE);
    expect(plan.autoExecutable).toBe(false); // money movement is never auto in P5.3A
    expect(plan.requiresManualReview).toBe(true);
  });

  it('C. authorized-not-captured on an auth/capture provider → PAYMENT_VOID', () => {
    const plan = planner.plan(
      base({
        paymentSucceeded: true,
        providerOutcome: 'SOLD_OUT',
        payment: { captured: false },
        paymentCapabilities: { supportsAuthorizeCapture: true, supportsRefund: true },
      }),
    );
    expect(plan.actions.map((a) => a.compensationType)).toContain(CompensationType.PAYMENT_VOID);
  });

  it('D. Provider confirmed, local confirm failed → LOCAL_CONFIRMATION_RETRY (auto-safe)', () => {
    const plan = planner.plan(
      base({ providerOutcome: 'CONFIRMED', localConfirmationFailed: true }),
    );
    expect(plan.actions.map((a) => a.compensationType)).toEqual([
      CompensationType.LOCAL_CONFIRMATION_RETRY,
    ]);
    expect(plan.autoExecutable).toBe(true);
  });

  it('D. retries exhausted → provider booking cancel (if supported) + MANUAL_REVIEW', () => {
    const plan = planner.plan(
      base({
        providerOutcome: 'CONFIRMED',
        localConfirmationFailed: true,
        localConfirmationRetriesExhausted: true,
        providerBookingId: 'pb1',
        providerCapabilities: { supportsCancel: true, idempotentCancellation: true },
      }),
    );
    const t = plan.actions.map((a) => a.compensationType);
    expect(t).toContain(CompensationType.PROVIDER_BOOKING_CANCEL);
    expect(t).toContain(CompensationType.MANUAL_REVIEW);
    expect(plan.requiresManualReview).toBe(true);
  });

  it('E. Local confirmed, Redis finalize failed → REDIS_LOCK_RELEASE only, no payment comp', () => {
    const plan = planner.plan(base({ redisFinalizeFailed: true }));
    expect(plan.actions.map((a) => a.compensationType)).toEqual([
      CompensationType.REDIS_LOCK_RELEASE,
    ]);
    expect(plan.autoExecutable).toBe(true);
  });

  it('F. Provider confirmed, capture failed → MANUAL_REVIEW (capture semantics not assumed)', () => {
    const plan = planner.plan(base({ captureFailed: true }));
    expect(plan.actions.map((a) => a.compensationType)).toEqual([CompensationType.MANUAL_REVIEW]);
    expect(plan.requiresManualReview).toBe(true);
  });

  it('G. Ticket issuance failed → no compensation record (retry via outbox), no refund', () => {
    const plan = planner.plan(base({ ticketIssuanceFailed: true }));
    expect(plan.actions).toHaveLength(0);
    expect(plan.requiresManualReview).toBe(false);
  });

  it('H. Duplicate callback → no compensation, idempotent success', () => {
    const plan = planner.plan(base({ duplicateCallback: true }));
    expect(plan.actions).toHaveLength(0);
    expect(plan.classification).toBe('DUPLICATE_CALLBACK');
  });

  it('is deterministic — same input yields the same plan', () => {
    const ctx = base({ redisLockPresent: true, localHoldActive: false });
    expect(JSON.stringify(planner.plan(ctx))).toEqual(JSON.stringify(planner.plan(ctx)));
  });
});
