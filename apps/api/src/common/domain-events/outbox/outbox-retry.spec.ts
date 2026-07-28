import { classifyOutboxFailure, nextAvailableAt } from './outbox-retry';
import {
  OutboxDeliveryPermanentError,
  OutboxDeliveryRetryableError,
  OutboxManualReviewError,
  OutboxPayloadTooLargeError,
  OutboxUnsupportedVersionError,
} from './outbox.errors';

describe('classifyOutboxFailure', () => {
  it('permanent → DEAD_LETTERED', () => {
    expect(classifyOutboxFailure(new OutboxPayloadTooLargeError('x'))).toMatchObject({
      class: 'PERMANENT',
      terminalStatus: 'DEAD_LETTERED',
    });
    expect(classifyOutboxFailure(new OutboxDeliveryPermanentError('x'))).toMatchObject({
      class: 'PERMANENT',
    });
  });
  it('unsupported version + manual review → MANUAL_REVIEW', () => {
    expect(classifyOutboxFailure(new OutboxUnsupportedVersionError('x')).terminalStatus).toBe(
      'MANUAL_REVIEW',
    );
    expect(classifyOutboxFailure(new OutboxManualReviewError('x')).terminalStatus).toBe(
      'MANUAL_REVIEW',
    );
  });
  it('retryable + unknown → RETRYABLE_FAILURE', () => {
    expect(classifyOutboxFailure(new OutboxDeliveryRetryableError('x'))).toMatchObject({
      class: 'RETRYABLE',
    });
    expect(classifyOutboxFailure(new Error('boom'))).toMatchObject({ class: 'RETRYABLE' });
  });
});

describe('nextAvailableAt backoff', () => {
  it('grows exponentially and is bounded by maxSeconds', () => {
    const now = 1_000_000;
    const a1 = nextAvailableAt(1, 5, 3600, now, () => 1).getTime();
    const a3 = nextAvailableAt(3, 5, 3600, now, () => 1).getTime();
    const aBig = nextAvailableAt(20, 5, 3600, now, () => 1).getTime();
    expect(a1).toBe(now + 5 * 1000); // 5 * 2^0
    expect(a3).toBe(now + 20 * 1000); // 5 * 2^2
    expect(aBig - now).toBeLessThanOrEqual(3600 * 1000); // capped
  });
  it('applies jitter over [0.5x, 1x]', () => {
    const now = 0;
    const lo = nextAvailableAt(3, 5, 3600, now, () => 0).getTime();
    const hi = nextAvailableAt(3, 5, 3600, now, () => 1).getTime();
    expect(lo).toBe(10_000); // 0.5 * 20s
    expect(hi).toBe(20_000);
  });
});
