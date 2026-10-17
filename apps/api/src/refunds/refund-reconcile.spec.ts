import {
  RECHECK_AFTER_MS,
  classifyLookupError,
  STRANGER_WINDOW_MS,
  isPlatformKey,
  keyGeneration,
  noneTooSoonReason,
  recheckAfter,
  reconcileRefund,
  refundKey,
  type ReconcileContext,
} from './refund-reconcile';
import type { ProviderRefundRecord } from '../payments/provider/payment-provider.interface';
import { PaymentNotCapturedError } from '../payments/domain/payment-errors';
import { normalizeProviderError } from '../payments/orchestration/resilient-executor';

const ASKED = new Date('2026-10-16T10:00:00Z');
const ctx = (over: Partial<ReconcileContext> = {}): ReconcileContext => ({
  refundId: 'r1',
  amountMinor: 5000,
  currentKey: 'etg-rf-r1',
  knownRefs: [],
  askedAt: ASKED,
  ...over,
});
const rec = (over: Partial<ProviderRefundRecord> = {}): ProviderRefundRecord => ({
  refundRef: 'rfnd_1',
  amountMinor: 5000,
  status: 'COMPLETED',
  idempotencyKey: 'etg-rf-r1',
  createdAt: new Date(ASKED.getTime() + 1000),
  ...over,
});

describe('when an empty lookup can be believed', () => {
  it('only RECHECK_AFTER_MS after the lost call started, and the hold says when', () => {
    const started = new Date('2026-10-16T12:00:00Z');
    expect(RECHECK_AFTER_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(recheckAfter(started).getTime() - started.getTime()).toBe(RECHECK_AFTER_MS);
    const reason = noneTooSoonReason(started);
    expect(reason).toMatch(/does not list this refund yet/);
    expect(reason).toMatch(/nothing was sent again/);
    expect(reason).toContain(recheckAfter(started).toISOString().slice(11, 16));
  });
});

describe('refund keys', () => {
  it('generation 1 is the bare stem; later ones keep the stem', () => {
    expect(refundKey('r1', 1)).toBe('etg-rf-r1');
    expect(refundKey('r1', 3)).toBe('etg-rf-r1-3');
    expect(keyGeneration('etg-rf-r1', 'r1')).toBe(1);
    expect(keyGeneration('etg-rf-r1-3', 'r1')).toBe(3);
  });

  it("does not take another refund's key, or a lookalike, for this one", () => {
    expect(keyGeneration('etg-rf-r10', 'r1')).toBeNull();
    expect(keyGeneration('etg-rf-r1-x', 'r1')).toBeNull();
    expect(keyGeneration('rcpt-1', 'r1')).toBeNull();
    expect(isPlatformKey('etg-rf-r2')).toBe(true);
    expect(isPlatformKey(null)).toBe(false);
  });

  it('fits Razorpay receipt (40 characters) for a cuid id', () => {
    expect(refundKey('cmvbad2p6000rhebm49lzmivk', 999).length).toBeLessThanOrEqual(40);
  });
});

describe('reconcileRefund', () => {
  it('FOUND: a live refund carrying this refund key', () => {
    expect(reconcileRefund([rec()], ctx())).toMatchObject({
      kind: 'FOUND',
      record: { refundRef: 'rfnd_1' },
    });
  });

  it('FOUND under an earlier generation of the key too', () => {
    expect(reconcileRefund([rec({ idempotencyKey: 'etg-rf-r1-2' })], ctx())).toMatchObject({
      kind: 'FOUND',
    });
  });

  it('NONE: the provider answered with nothing that could be this refund', () => {
    expect(reconcileRefund([], ctx())).toEqual({ kind: 'NONE' });
  });

  it("NONE: other refunds of ours, known refs, refused refunds and older strangers don't count", () => {
    const records = [
      rec({ refundRef: 'rfnd_sib', idempotencyKey: 'etg-rf-r2' }), // a sibling refund of ours
      rec({ refundRef: 'rfnd_known', idempotencyKey: null }), // a refund row here carries it
      rec({ refundRef: 'rfnd_x', idempotencyKey: null, status: 'FAILED' }),
      rec({ refundRef: 'rfnd_other', idempotencyKey: null, amountMinor: 100 }),
      rec({
        refundRef: 'rfnd_old',
        idempotencyKey: null,
        createdAt: new Date(ASKED.getTime() - STRANGER_WINDOW_MS - 1),
      }),
    ];
    expect(reconcileRefund(records, ctx({ knownRefs: ['rfnd_known'] }))).toEqual({
      kind: 'NONE',
    });
  });

  it('UNMATCHED: an unkeyed refund of the same amount since it was asked for', () => {
    const r = reconcileRefund([rec({ idempotencyKey: null })], ctx());
    expect(r.kind).toBe('UNMATCHED');
  });

  it('UNMATCHED: an unkeyed same-amount refund with no creation time', () => {
    expect(reconcileRefund([rec({ idempotencyKey: null, createdAt: null })], ctx()).kind).toBe(
      'UNMATCHED',
    );
  });

  it('UNMATCHED: two live refunds made for this one refund (already paid twice)', () => {
    const r = reconcileRefund(
      [rec(), rec({ refundRef: 'rfnd_2', idempotencyKey: 'etg-rf-r1-2' })],
      ctx(),
    );
    expect(r).toMatchObject({ kind: 'UNMATCHED', reason: expect.stringMatching(/2 refunds/) });
  });

  it('UNMATCHED: our key, but a different amount', () => {
    expect(reconcileRefund([rec({ amountMinor: 4000 })], ctx()).kind).toBe('UNMATCHED');
  });

  it('REFUSED: the current key was taken and refused by the provider', () => {
    expect(reconcileRefund([rec({ status: 'FAILED' })], ctx())).toMatchObject({
      kind: 'REFUSED',
    });
  });

  it('an older refused generation is not a refusal of the current key', () => {
    expect(
      reconcileRefund([rec({ status: 'FAILED' })], ctx({ currentKey: 'etg-rf-r1-2' })),
    ).toEqual({ kind: 'NONE' });
  });
});

describe('a refund lookup that threw', () => {
  const unpaid = new PaymentNotCapturedError(
    'order_1',
    'Razorpay holds no captured payment for order order_1: nothing was paid on it, so there is nothing to refund.',
  );

  // The provider answered: nothing was captured. Not "could not be asked", which a tick unlocks.
  it('is NOT_PAID when the provider holds no captured payment', () => {
    const r = classifyLookupError(unpaid);
    expect(r.kind).toBe('NOT_PAID');
    expect(r).toMatchObject({ reason: expect.stringMatching(/nothing to refund/) });
    expect((r as { reason: string }).reason).not.toMatch(/could not be asked/);
  });

  it('is NOT_PAID when the orchestrator wrapped that answer', () => {
    // What `executeWithFailover` actually throws for an adapter error.
    expect(classifyLookupError(normalizeProviderError(unpaid, 'razorpay')).kind).toBe('NOT_PAID');
  });

  it('is UNAVAILABLE, with what was said, for anything else', () => {
    expect(classifyLookupError(new Error('Razorpay 503'))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'The payment provider could not be asked whether it made this refund: Razorpay 503',
    });
    expect(
      classifyLookupError(normalizeProviderError(new Error('timed out'), 'razorpay')).kind,
    ).toBe('UNAVAILABLE');
  });
});
