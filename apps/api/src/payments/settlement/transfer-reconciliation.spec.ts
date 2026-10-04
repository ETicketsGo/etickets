import {
  classifyTransferEvidence,
  isReconcilable,
  lookupFor,
  reconcileTransferAttempt,
  type LocalTransferFacts,
} from './transfer-reconciliation';
import type { TransferState } from '../provider/payment-provider.interface';

/**
 * unit — what a provider's answer about a transfer proves, and what it does not.
 *
 * Pure functions over evidence, so every branch is testable without an SDK or a sandbox. Nothing
 * here can move money; that is the property under test as much as any individual case.
 */

const local = (over: Partial<LocalTransferFacts> = {}): LocalTransferFacts => ({
  attemptId: 'att_1',
  settlementId: 's_1',
  organizationId: 'org_1',
  status: 'UNKNOWN',
  requestedMinor: 50_000,
  currency: 'inr',
  providerTransferId: null,
  idempotencyKey: 'settlement_s_1_0',
  destinationAccountId: 'acc_1',
  ...over,
});

const state = (over: Partial<TransferState> = {}): TransferState => ({
  transferId: 'trf_1',
  disposition: 'SENT',
  amountMinor: 50_000,
  currency: 'inr',
  providerStatusRaw: 'processed',
  ...over,
});

describe('which attempts are worth asking about', () => {
  it('asks about the ones whose outcome we never learned', () => {
    expect(isReconcilable('UNKNOWN')).toBe(true);
    expect(isReconcilable('REQUESTED')).toBe(true);
  });

  it('leaves settled ones alone', () => {
    // A provider refusal and a recorded success are both answers. Asking again achieves nothing.
    expect(isReconcilable('FAILED')).toBe(false);
    expect(isReconcilable('SUCCEEDED')).toBe(false);
  });
});

describe('what we can offer a provider as identification', () => {
  it('always offers the identity we chose, because it is the one we always keep', () => {
    /*
      THE SHAPE OF THE HARD CASE. The attempts worth reconciling have no provider transfer id -
      the provider never answered - so a lookup keyed on its id is unavailable exactly when it
      matters. What survives is what we sent.
    */
    const l = lookupFor(local({ providerTransferId: null }));
    expect(l.transferId).toBeNull();
    expect(l.idempotencyKey).toBe('settlement_s_1_0');
    expect(l.amountMinor).toBe(50_000);
    expect(l.currency).toBe('inr');
  });

  it('passes the transfer id through on the easy case', () => {
    expect(lookupFor(local({ providerTransferId: 'trf_9' })).transferId).toBe('trf_9');
  });
});

describe('a provider that says it sent the money', () => {
  it('resolves only when it is the money we asked for', () => {
    const out = classifyTransferEvidence(local(), state());
    expect(out).toMatchObject({ kind: 'RESOLVED', disposition: 'SENT' });
  });

  it('raises a finding when the amount disagrees', () => {
    /*
      Worse than not knowing: both sides believe they are right. A worker must not pick one, and
      above all must not quietly adopt the provider figure as the truth.
    */
    const out = classifyTransferEvidence(local(), state({ amountMinor: 49_000 }));
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'AMOUNT_DISAGREES' });
    expect(out.kind === 'FINDING' && out.detail).toMatch(/50000.*49000/);
  });

  it('raises a finding when the currency disagrees', () => {
    const out = classifyTransferEvidence(local(), state({ currency: 'usd' }));
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'CURRENCY_DISAGREES' });
  });

  it('accepts a provider that reports no amount, rather than inventing a mismatch', () => {
    // Absent is not different. A provider that does not say cannot be said to disagree.
    const out = classifyTransferEvidence(local(), state({ amountMinor: null, currency: null }));
    expect(out.kind).toBe('RESOLVED');
  });

  it('compares currency case-insensitively', () => {
    expect(classifyTransferEvidence(local(), state({ currency: 'INR' })).kind).toBe('RESOLVED');
  });
});

describe('a provider that says it did not send the money', () => {
  it('resolves an attempt we were unsure about', () => {
    const out = classifyTransferEvidence(
      local({ status: 'UNKNOWN' }),
      state({ disposition: 'FAILED' }),
    );
    expect(out).toMatchObject({ kind: 'RESOLVED', disposition: 'FAILED' });
  });

  it('raises a contradiction when we had recorded the money as sent', () => {
    /*
      The one that must never be auto-corrected. Our ledger says the organizer has it; the
      provider says it never went. Rewriting either side would destroy the evidence that they
      ever disagreed.
    */
    const out = classifyTransferEvidence(
      local({ status: 'SUCCEEDED' }),
      state({ disposition: 'FAILED' }),
    );
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'PROVIDER_CONTRADICTS_LOCAL' });
    expect(out.kind === 'FINDING' && out.detail).toMatch(/nothing has been changed/i);
  });
});

describe('answers that are not answers', () => {
  it('keeps PENDING open rather than converting it into a decision', () => {
    const out = classifyTransferEvidence(local(), state({ disposition: 'PENDING' }));
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'STILL_UNRESOLVED' });
  });

  it('treats NOT_FOUND as evidence, never as a clearance to resend', () => {
    /*
      THE DANGEROUS INFERENCE. "They have never heard of it, so nothing happened" is how the
      same payout goes out twice: a lookup may be eventually consistent, or keyed on something
      the create call never returned.
    */
    const out = classifyTransferEvidence(local(), state({ disposition: 'NOT_FOUND' }));
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'PROVIDER_HAS_NO_RECORD' });
    expect(out.kind === 'FINDING' && out.detail).toMatch(/not proof that nothing was sent/i);
    // Emphatically not a resolution.
    expect(out.kind).not.toBe('RESOLVED');
  });

  it('keeps UNKNOWN open', () => {
    const out = classifyTransferEvidence(local(), state({ disposition: 'UNKNOWN' }));
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'STILL_UNRESOLVED' });
  });
});

describe('reconciling one attempt', () => {
  it('does nothing for a settled attempt when there is nothing to compare against', async () => {
    const out = await reconcileTransferAttempt(local({ status: 'SUCCEEDED' }), null);
    expect(out.kind).toBe('AGREES');
  });

  it('still VERIFIES a settled attempt when evidence is offered', async () => {
    /*
      Being settled is not a reason to ignore evidence somebody actually fetched. A transfer we
      recorded as sent, which the provider later says it never sent, is the most important thing
      this module can catch - and the worker never selects settled attempts anyway, so nothing
      here causes needless asking.
    */
    const reader = { getTransferState: jest.fn(async () => state({ disposition: 'FAILED' })) };
    const out = await reconcileTransferAttempt(local({ status: 'SUCCEEDED' }), reader);
    expect(reader.getTransferState).toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'PROVIDER_CONTRADICTS_LOCAL' });
  });

  it('agrees when a settled attempt and the provider say the same thing', async () => {
    const reader = { getTransferState: jest.fn(async () => state()) };
    const out = await reconcileTransferAttempt(local({ status: 'SUCCEEDED' }), reader);
    expect(out.kind).toBe('AGREES');
  });

  it('records that it cannot be asked, rather than guessing', async () => {
    const out = await reconcileTransferAttempt(local(), null);
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'CANNOT_BE_ASKED', state: null });
  });

  it('keeps the question open when the provider cannot be reached', async () => {
    // Failing to ask is not evidence about the money, so nothing about the money changes.
    const reader = {
      getTransferState: jest.fn(async () => {
        throw new Error('network down');
      }),
    };
    const out = await reconcileTransferAttempt(local(), reader);
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'STILL_UNRESOLVED', state: null });
  });

  it('asks using everything we hold', async () => {
    const reader = { getTransferState: jest.fn(async () => state()) };
    await reconcileTransferAttempt(local(), reader);
    expect(reader.getTransferState).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'settlement_s_1_0', amountMinor: 50_000 }),
    );
  });

  it('is given a reader that cannot move money, by type rather than by rule', async () => {
    /*
      The same narrowing the reversal sweeper uses. The object handed in has ONE method and it
      reads; `createTransfer` and friends are not merely unused here, they are absent.
    */
    const reader = { getTransferState: jest.fn(async () => state()) };
    await reconcileTransferAttempt(local(), reader);
    expect(Object.keys(reader)).toEqual(['getTransferState']);
  });
});
