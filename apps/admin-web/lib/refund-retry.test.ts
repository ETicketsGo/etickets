import { describe, expect, it } from 'vitest';
import { lookupSentence, retryOutcomeText, retrySucceeded, showRetryButton } from './refund-retry';

describe('what a refund retry answered', () => {
  it('counts paid and accepted as taken, and nothing else', () => {
    expect(retrySucceeded({ outcome: 'COMPLETED' })).toBe(true);
    expect(retrySucceeded({ outcome: 'PROCESSING' })).toBe(true);
    expect(retrySucceeded({ outcome: 'FAILED' })).toBe(false);
    expect(retrySucceeded({ outcome: 'ERROR' })).toBe(false);
  });

  it('never tells the admin an unanswered call moved no money', () => {
    const text = retryOutcomeText({ outcome: 'ERROR' });
    expect(text).toMatch(/may or may not have moved/);
    expect(text).not.toMatch(/No money moved/);
    expect(retryOutcomeText({ outcome: 'FAILED' })).toMatch(/No money moved/);
  });
});

describe('a retry the provider could not settle, or had already paid', () => {
  it('says a held refund needs a manual check and may have moved money', () => {
    const text = retryOutcomeText({ outcome: 'NEEDS_REVIEW' });
    expect(text).toMatch(/manual check/);
    expect(text).toMatch(/may or may not have moved/);
    expect(retrySucceeded({ outcome: 'NEEDS_REVIEW' })).toBe(false);
  });

  it('says a recorded refund sent no money again', () => {
    expect(retryOutcomeText({ outcome: 'COMPLETED', recorded: true })).toMatch(
      /No money was sent again/,
    );
    expect(retryOutcomeText({ outcome: 'COMPLETED' })).not.toMatch(/recorded/);
  });
});

// QA ETG-IND-2026-000013/14/15: "could not be asked" and an enabled button for an unpaid order.
describe('the retry card for an order nobody paid', () => {
  const notPaid = {
    allowed: false,
    needsConfirmation: false,
    refusal: 'NOT_PAID',
  };

  it('says nothing was paid, not that the provider could not be asked', () => {
    const text = lookupSentence(
      { kind: 'NOT_PAID', reason: 'Razorpay holds no captured payment for order order_1.' },
      'Razorpay',
    );
    expect(text).toBe(
      'Razorpay was asked: nothing was paid on this order, so there is nothing to refund.',
    );
  });

  it('hides Try the refund again', () => {
    expect(showRetryButton(notPaid)).toBe(false);
    // Even if an API ever paired the refusal with a confirmation flag.
    expect(showRetryButton({ ...notPaid, needsConfirmation: true })).toBe(false);
  });

  it('still offers it where the API allows it, or allows it with the tick', () => {
    expect(showRetryButton({ allowed: true, needsConfirmation: false, refusal: null })).toBe(true);
    expect(
      showRetryButton({ allowed: false, needsConfirmation: true, refusal: 'NEEDS_CONFIRMATION' }),
    ).toBe(true);
    expect(showRetryButton({ allowed: false, needsConfirmation: false, refusal: 'TOO_SOON' })).toBe(
      false,
    );
    expect(showRetryButton(undefined)).toBe(false);
  });
});

describe('a provider that could not be asked', () => {
  it("shows the API's own reason, not only a fixed sentence", () => {
    const text = lookupSentence(
      {
        kind: 'UNAVAILABLE',
        reason:
          'The payment provider could not be asked whether it made this refund: Razorpay 503 SERVER_ERROR: try later',
      },
      'Razorpay',
    );
    expect(text).toBe(
      'Razorpay could not be asked whether it made this refund. What it said: Razorpay 503 SERVER_ERROR: try later',
    );
    expect(lookupSentence({ kind: 'UNAVAILABLE' }, '')).toBe(
      'The payment provider could not be asked whether it made this refund.',
    );
  });

  it('keeps the other answers as they were', () => {
    expect(lookupSentence({ kind: 'NONE' }, 'Razorpay')).toBe(
      'Razorpay was asked: it shows no refund for this payment.',
    );
    expect(lookupSentence({ kind: 'FOUND', providerRef: 'rfnd_1' }, 'Razorpay')).toMatch(/rfnd_1/);
    expect(lookupSentence(null, 'Razorpay')).toBeNull();
  });
});
