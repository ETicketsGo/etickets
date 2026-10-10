import { describe, expect, it } from 'vitest';
import { moneyStatusLabel, moneyStatusOptions, moneyStatusTone } from './money-status';

describe('the money status vocabulary', () => {
  it('names states in words, never the enum', () => {
    expect(moneyStatusLabel('booking', 'PENDING_PAYMENT')).toBe('Awaiting payment');
    expect(moneyStatusLabel('payment', 'SUCCEEDED')).toBe('Paid');
    expect(moneyStatusLabel('refund', 'REQUESTED')).toBe('Waiting for a decision');
    expect(moneyStatusLabel('settlement', 'TRANSFER_PROCESSING')).toBe('Transfer in progress');
  });

  it('colours a state by what it means for THIS entity', () => {
    // A refunded booking is a normal end of a sale, not the red of a failed charge.
    expect(moneyStatusTone('booking', 'REFUNDED')).toBe('info');
    expect(moneyStatusTone('payment', 'FAILED')).toBe('error');
    // A refund waiting on somebody is the amber of "needs you".
    expect(moneyStatusTone('refund', 'REQUESTED')).toBe('warning');
    // ... and a completed one is done.
    expect(moneyStatusTone('refund', 'COMPLETED')).toBe('success');
  });

  it('keeps a state it has never heard of legible and neutral', () => {
    expect(moneyStatusLabel('payout', 'ON_HOLD_FOR_REVIEW')).toBe('On hold for review');
    expect(moneyStatusTone('payout', 'ON_HOLD_FOR_REVIEW')).toBe('neutral');
  });

  it('gives a filter the same words as the pills, keyed on the raw status', () => {
    expect(moneyStatusOptions('payout', ['PAID', 'FAILED'])).toEqual([
      { value: 'PAID', label: 'Paid' },
      { value: 'FAILED', label: 'Failed' },
    ]);
  });
});
