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
