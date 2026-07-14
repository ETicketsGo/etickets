import { CircuitBreaker } from './circuit-breaker';
import {
  executeWithFailover,
  normalizeProviderError,
  type ExecutionCandidate,
} from './resilient-executor';
import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';

const noSleep = { sleep: async () => undefined };

function candidate<T>(
  provider: string,
  run: () => Promise<T>,
  over: Partial<ExecutionCandidate<T>> = {},
): ExecutionCandidate<T> {
  return {
    provider,
    breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000, now: () => 0 }),
    timeoutMs: 0, // disable real timers in tests unless a test opts in
    maxRetries: 2,
    retryBackoffMs: 1,
    run,
    ...over,
  };
}

const retryable = (provider: string) =>
  new PaymentProviderError(PaymentErrorCode.PROVIDER_UNAVAILABLE, 'down', provider);
const declined = (provider: string) =>
  new PaymentProviderError(PaymentErrorCode.CARD_DECLINED, 'no', provider);

describe('executeWithFailover', () => {
  it('returns the first candidate result on success', async () => {
    const a = jest.fn().mockResolvedValue('ok');
    const res = await executeWithFailover([candidate('a', a)], noSleep);
    expect(res).toBe('ok');
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable error up to maxRetries before failing over', async () => {
    const a = jest.fn().mockRejectedValue(retryable('a'));
    const b = jest.fn().mockResolvedValue('from-b');
    const res = await executeWithFailover(
      [candidate('a', a, { maxRetries: 2 }), candidate('b', b)],
      noSleep,
    );
    expect(res).toBe('from-b');
    expect(a).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does NOT fail over on a non-retryable (terminal) error', async () => {
    const a = jest.fn().mockRejectedValue(declined('a'));
    const b = jest.fn().mockResolvedValue('from-b');
    await expect(
      executeWithFailover([candidate('a', a), candidate('b', b)], noSleep),
    ).rejects.toMatchObject({ code: PaymentErrorCode.CARD_DECLINED });
    expect(a).toHaveBeenCalledTimes(1); // no retry
    expect(b).not.toHaveBeenCalled(); // no failover
  });

  it('skips a candidate whose breaker is open', async () => {
    const openBreaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      now: () => 0,
    });
    openBreaker.recordFailure(); // trip it
    const a = jest.fn().mockResolvedValue('nope');
    const b = jest.fn().mockResolvedValue('from-b');
    const res = await executeWithFailover(
      [candidate('a', a, { breaker: openBreaker }), candidate('b', b)],
      noSleep,
    );
    expect(res).toBe('from-b');
    expect(a).not.toHaveBeenCalled();
  });

  it('trips the breaker after a candidate is exhausted', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => 0 });
    const a = jest.fn().mockRejectedValue(retryable('a'));
    await expect(
      executeWithFailover([candidate('a', a, { breaker, maxRetries: 0 })], noSleep),
    ).rejects.toBeInstanceOf(PaymentProviderError);
    expect(breaker.canAttempt()).toBe(false);
  });

  it('throws PROVIDER_UNAVAILABLE when there are no candidates', async () => {
    await expect(executeWithFailover([], noSleep)).rejects.toMatchObject({
      code: PaymentErrorCode.PROVIDER_UNAVAILABLE,
    });
  });

  it('times out a slow provider as a retryable error', async () => {
    const slow = () => new Promise<string>(() => {}); // never resolves
    const fast = jest.fn().mockResolvedValue('from-b');
    const res = await executeWithFailover(
      [candidate('a', slow, { timeoutMs: 5, maxRetries: 0 }), candidate('b', fast)],
      noSleep,
    );
    expect(res).toBe('from-b');
  });
});

describe('normalizeProviderError', () => {
  it('passes through an existing PaymentProviderError', () => {
    const e = retryable('a');
    expect(normalizeProviderError(e, 'a')).toBe(e);
  });
  it('wraps unknown errors as non-retryable UNKNOWN', () => {
    const n = normalizeProviderError(new Error('boom'), 'a');
    expect(n.code).toBe(PaymentErrorCode.UNKNOWN);
    expect(n.retryable).toBe(false);
  });
});
