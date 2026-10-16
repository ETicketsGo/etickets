import {
  STRANGER_WINDOW_MS,
  isPlatformKey,
  keyGeneration,
  reconcileRefund,
  refundKey,
  type ReconcileContext,
} from './refund-reconcile';
import type { ProviderRefundRecord } from '../payments/provider/payment-provider.interface';

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
