import { describe, expect, it } from 'vitest';
import { failedRefundAdvice, historyLine, historyLines, type HistoryEntry } from './history';

const entry = (
  action: string,
  createdAt: string,
  metadata?: Record<string, unknown>,
): HistoryEntry => ({
  action,
  createdAt,
  actor: { email: 'a@example.test', fullName: 'Asha' },
  metadata,
});

describe('a record history', () => {
  it('reads oldest first, in sentences, with who did it', () => {
    const lines = historyLines([
      entry('REFUND_PROCESSING', '2026-10-15T09:05:00Z', { providerRef: 'rfnd_1' }),
      entry('REFUND_REQUESTED', '2026-10-15T09:04:00Z', { via: 'ACCOUNT', amountMinor: 1 }),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Refund asked for',
      'Refund approved and sent to the payment provider',
    ]);
    expect(lines[0].detail).toBe('Asked from their account');
    expect(lines[1].detail).toBe('Provider reference rfnd_1');
    expect(lines[0].who).toBe('Asha');
  });

  it('carries a recorded reason, and calls an action with no person the system', () => {
    const line = historyLine({
      action: 'EVENT_STATUS_CHANGED',
      createdAt: '2026-10-15T09:00:00Z',
      actor: null,
      metadata: { reason: 'Venue licence query' },
    });
    expect(line.text).toBe('Event status changed');
    expect(line.detail).toBe('Reason: Venue licence query');
    expect(line.who).toBe('System');
  });

  it('reads a cinema legal type change as before -> after, with the reason', () => {
    const line = historyLine(
      entry('CINEMA_LEGAL_TYPE_CHANGED', '2026-10-16T09:00:00Z', {
        change: 'not set, Multiplex, not set -> Municipal corporation, Multiplex, Air-conditioned',
        reason: 'Licence copy received',
        before: { localBodyType: null },
      }),
    );
    expect(line.text).toBe('Legal type changed');
    expect(line.detail).toBe(
      'not set, Multiplex, not set -> Municipal corporation, Multiplex, Air-conditioned. Reason: Licence copy received',
    );
  });

  it('leaves out the record of an admin opening the page, which is not something that happened to it', () => {
    const lines = historyLines([
      entry('PLATFORM_ORGANIZER_ACCESS_ALLOWED', '2026-10-15T09:00:00Z', {
        reason: 'CAPABILITY_HELD',
      }),
      entry('BOOKING_CONFIRMED', '2026-10-15T08:00:00Z'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Paid and confirmed. Tickets issued']);
  });

  it('marks what went wrong', () => {
    expect(historyLine(entry('REFUND_FAILED', '2026-10-15T09:00:00Z')).problem).toBe(true);
    expect(historyLine(entry('REFUND_COMPLETED', '2026-10-15T09:00:00Z')).problem).toBe(false);
  });
});

describe('what to do about a refund that did not go through', () => {
  it('says the customer has neither tickets nor money when the provider failed it later', () => {
    const advice = failedRefundAdvice([
      entry('REFUND_PROCESSING', '2026-10-15T09:00:00Z'),
      entry('REFUND_FAILED_AT_PROVIDER', '2026-10-15T10:00:00Z'),
    ]);
    expect(advice.cause).toMatch(/neither their tickets nor their money/);
    expect(advice.steps.join(' ')).toMatch(/Try the refund again/);
    expect(advice.steps.join(' ')).toMatch(/tickets stay cancelled/);
  });

  it('says nothing is owed twice when the tickets had already gone back', () => {
    expect(
      failedRefundAdvice([entry('REFUND_TICKETS_NOT_LIVE', '2026-10-15T09:00:00Z')]).cause,
    ).toMatch(/not owed this amount twice/);
  });

  it('says the customer still holds their tickets when the provider refused it outright', () => {
    expect(failedRefundAdvice([entry('REFUND_FAILED', '2026-10-15T09:00:00Z')]).cause).toMatch(
      /still holds their tickets/,
    );
  });

  it('does not invent a reason when none was recorded', () => {
    expect(failedRefundAdvice([]).cause).toMatch(/no reason was recorded/);
  });
});

describe('a retried refund in its history', () => {
  it('says what the provider answered, and marks a refusal or a lost answer as a problem', () => {
    const lines = historyLines([
      entry('REFUND_RETRY_STARTED', '2026-10-15T09:00:00Z', { confirmedNoProviderRefund: true }),
      entry('REFUND_RETRY_RESULT', '2026-10-15T09:00:05Z', {
        outcome: 'FAILED',
        message: 'The payment provider refused this refund again.',
      }),
      entry('REFUND_RETRY_RESULT', '2026-10-15T09:10:05Z', {
        outcome: 'COMPLETED',
        providerRef: 'rfnd_2',
      }),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Sent to the payment provider again',
      'Tried again: the payment provider refused it',
      'Tried again: the refund was paid back',
    ]);
    expect(lines[0].detail).toBe('Checked the provider dashboard first: no refund there');
    expect(lines[1].detail).toBe('Provider said: The payment provider refused this refund again.');
    expect(lines.map((l) => l.problem)).toEqual([false, true, false]);
    expect(lines[2].detail).toBe('Provider reference rfnd_2');
  });

  it('never calls an unanswered retry paid', () => {
    const line = historyLine(
      entry('REFUND_RETRY_RESULT', '2026-10-15T09:00:00Z', { outcome: 'ERROR' }),
    );
    expect(line.text).toMatch(/did not answer/);
    expect(line.problem).toBe(true);
  });
});

describe('a refund held for a manual check', () => {
  it('puts the manual check first, before any older failure', () => {
    const advice = failedRefundAdvice(
      [entry('REFUND_FAILED', '2026-10-15T09:00:00Z')],
      'The payment provider could not be asked whether it made this refund: 503',
    );
    expect(advice.cause).toMatch(/could not be asked/);
    expect(advice.steps.join(' ')).toMatch(/do not send it again/);
  });

  it('reads the provider lookup and the hold in the history, and marks the hold', () => {
    const lines = historyLines([
      entry('REFUND_PROVIDER_LOOKUP', '2026-10-15T09:00:00Z', { result: 'UNAVAILABLE' }),
      entry('REFUND_NEEDS_MANUAL_REVIEW', '2026-10-15T09:00:01Z', { reason: 'Razorpay 503' }),
      entry('REFUND_RETRY_RESULT', '2026-10-15T09:10:00Z', { outcome: 'NEEDS_REVIEW' }),
    ]);
    expect(lines[0].detail).toBe('The provider could not be asked');
    expect(lines[1].text).toMatch(/manual check/);
    expect(lines[1].detail).toBe('Reason: Razorpay 503');
    expect(lines.map((l) => l.problem)).toEqual([false, true, true]);
  });
});

// QA ETG-IND-2026-000013/14/15: step 2 told the admin to retry a refund of an order nobody paid.
describe('a failed refund on an order nobody paid', () => {
  it('says to resolve the booking, never to try again', () => {
    const advice = failedRefundAdvice([], null, 'NOT_PAID');
    expect(advice.cause).toMatch(/nothing to refund/);
    expect(advice.steps.join(' ')).toMatch(/check how it was confirmed/);
    expect(advice.steps.join(' ')).toMatch(/cancel the booking as unpaid/);
    expect(advice.steps.join(' ')).not.toMatch(/use Try the refund again/);
  });

  it('wins over a manual-review hold', () => {
    expect(failedRefundAdvice([], 'Held', 'NOT_PAID').cause).toMatch(/nothing to refund/);
  });

  it('leaves the other cases as they were', () => {
    expect(failedRefundAdvice([], null, 'UNAVAILABLE').steps.join(' ')).toMatch(
      /Try the refund again/,
    );
  });
});
