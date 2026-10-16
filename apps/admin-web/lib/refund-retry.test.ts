import { describe, expect, it } from 'vitest';
import { retryOutcomeText, retrySucceeded } from './refund-retry';

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
