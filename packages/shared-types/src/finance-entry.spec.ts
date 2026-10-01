import { describe, it, expect } from 'vitest';
import { financeStateOf, type FinanceState } from './finance-entry';

/*
  These enums live in apps/api/prisma/schema.prisma. They are listed here so that adding a value
  there without deciding what an organizer should be told fails HERE, rather than reaching a
  Finance screen as an unmapped status nobody chose words for.
*/
const PAYOUT_STATUSES = ['PENDING', 'SCHEDULED', 'PAID', 'FAILED'];
const SETTLEMENT_STATUSES = [
  'PENDING',
  'HELD',
  'ELIGIBLE',
  'APPROVED',
  'TRANSFER_PROCESSING',
  'TRANSFERRED',
  'PARTIALLY_REFUNDED',
  'BLOCKED',
  'FAILED',
  'REVERSED',
];

describe('every persisted status has an organizer-facing state', () => {
  it.each(PAYOUT_STATUSES)('PayoutStatus %s is mapped', (status) => {
    expect(financeStateOf('PAYOUT', status)).not.toBeNull();
  });

  it.each(SETTLEMENT_STATUSES)('SettlementStatus %s is mapped', (status) => {
    expect(financeStateOf('SETTLEMENT', status)).not.toBeNull();
  });
});

describe('the mapping does not flatten what matters', () => {
  it('keeps money that moved apart from money that has not', () => {
    expect(financeStateOf('PAYOUT', 'PAID')).toBe('PAID');
    expect(financeStateOf('SETTLEMENT', 'TRANSFERRED')).toBe('PAID');
    expect(financeStateOf('PAYOUT', 'PENDING')).toBe('PENDING');
    expect(financeStateOf('SETTLEMENT', 'HELD')).toBe('PENDING');
  });

  it('does not let a partly refunded settlement read as simply paid', () => {
    /*
      Collapsing this into PAID would tell an organizer the whole amount reached them when some
      of it has already been taken back.
    */
    expect(financeStateOf('SETTLEMENT', 'PARTIALLY_REFUNDED')).toBe('PARTIALLY_REFUNDED');
    expect(financeStateOf('SETTLEMENT', 'PARTIALLY_REFUNDED')).not.toBe('PAID');
  });

  it('treats a reversed transfer as needing a person, not as paid or pending', () => {
    /*
      Money went out and came back, and the status alone does not say why: an administrative
      reversal leaves the organizer unpaid, a customer refund means the revenue is gone. Until an
      explicit financial disposition exists, neither answer may be assumed.
    */
    const reversed = financeStateOf('SETTLEMENT', 'REVERSED');
    expect(reversed).toBe('ATTENTION_REQUIRED');
    expect(reversed).not.toBe('PAID');
    expect(reversed).not.toBe('PENDING');
  });

  it('sends every failure to the same place, because every failure needs the same thing', () => {
    const attention: FinanceState = 'ATTENTION_REQUIRED';
    expect(financeStateOf('PAYOUT', 'FAILED')).toBe(attention);
    expect(financeStateOf('SETTLEMENT', 'FAILED')).toBe(attention);
    expect(financeStateOf('SETTLEMENT', 'BLOCKED')).toBe(attention);
  });

  it('separates committed from landed', () => {
    expect(financeStateOf('PAYOUT', 'SCHEDULED')).toBe('IN_PROGRESS');
    expect(financeStateOf('SETTLEMENT', 'APPROVED')).toBe('IN_PROGRESS');
    expect(financeStateOf('SETTLEMENT', 'TRANSFER_PROCESSING')).toBe('IN_PROGRESS');
  });
});

describe('an unknown status', () => {
  it('returns null rather than guessing', () => {
    // A provider or a migration adding a state we have not met must not read as "on its way".
    expect(financeStateOf('SETTLEMENT', 'SOME_NEW_PROVIDER_STATE')).toBeNull();
    expect(financeStateOf('PAYOUT', 'SOME_NEW_STATE')).toBeNull();
  });

  it('does not borrow the other system’s table', () => {
    /*
      HELD is a settlement status and means nothing on the payout ledger. If the lookup fell back
      to the other table, a payout would silently acquire a state it can never be in.
    */
    expect(financeStateOf('PAYOUT', 'HELD')).toBeNull();
    expect(financeStateOf('PAYOUT', 'TRANSFERRED')).toBeNull();
    expect(financeStateOf('SETTLEMENT', 'SCHEDULED')).toBeNull();
  });
});
