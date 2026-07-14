/**
 * Resilient, failover-aware execution of a payment operation across an ordered
 * list of provider candidates (ADR-021). For each candidate it applies, in order:
 *   1. its circuit breaker (skip when OPEN),
 *   2. a per-attempt timeout,
 *   3. bounded retries with backoff on RETRYABLE errors.
 * A non-retryable error (card declined, invalid request) is terminal — it is
 * rethrown immediately with no failover. A candidate exhausted by retryable errors
 * trips its breaker and execution fails over to the next candidate. When every
 * candidate is exhausted the last normalized error is thrown.
 *
 * Pure and dependency-injected (clock + sleep) so it is unit-testable without real
 * timers or providers.
 */
import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';
import type { CircuitBreaker } from './circuit-breaker';

export interface ExecutionCandidate<T> {
  provider: string;
  breaker: CircuitBreaker;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  run: () => Promise<T>;
}

export interface ExecutorDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Normalize any thrown value into a PaymentProviderError for uniform handling. */
export function normalizeProviderError(err: unknown, provider: string): PaymentProviderError {
  if (err instanceof PaymentProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Unknown provider/SDK failures are treated as non-retryable by default so we
  // never silently double-charge; timeouts (created below) are the retryable path.
  return new PaymentProviderError(PaymentErrorCode.UNKNOWN, message, provider, err);
}

function timeout(ms: number, provider: string): { promise: Promise<never>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(
        new PaymentProviderError(
          PaymentErrorCode.PROVIDER_TIMEOUT,
          `Provider '${provider}' timed out after ${ms}ms.`,
          provider,
        ),
      );
    }, ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

async function runOnce<T>(candidate: ExecutionCandidate<T>): Promise<T> {
  if (candidate.timeoutMs <= 0) return candidate.run();
  const t = timeout(candidate.timeoutMs, candidate.provider);
  try {
    return await Promise.race([candidate.run(), t.promise]);
  } finally {
    t.cancel();
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute the first candidate that succeeds, applying retry/timeout/circuit rules.
 * Throws the last PaymentProviderError when all candidates are exhausted.
 */
export async function executeWithFailover<T>(
  candidates: readonly ExecutionCandidate<T>[],
  deps: ExecutorDeps = {},
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  if (candidates.length === 0) {
    throw new PaymentProviderError(
      PaymentErrorCode.PROVIDER_UNAVAILABLE,
      'No payment provider available to execute the operation.',
      'orchestrator',
    );
  }

  let lastError: PaymentProviderError | undefined;

  for (const candidate of candidates) {
    if (!candidate.breaker.canAttempt()) {
      lastError = new PaymentProviderError(
        PaymentErrorCode.PROVIDER_UNAVAILABLE,
        `Circuit open for provider '${candidate.provider}'.`,
        candidate.provider,
      );
      continue;
    }

    const attempts = Math.max(1, candidate.maxRetries + 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await runOnce(candidate);
        candidate.breaker.recordSuccess();
        return result;
      } catch (raw) {
        const error = normalizeProviderError(raw, candidate.provider);
        lastError = error;
        if (!error.retryable) {
          // Terminal business error (e.g. declined): do not fail over or retry.
          candidate.breaker.recordSuccess(); // provider is healthy; the request failed
          throw error;
        }
        if (attempt < attempts) {
          await sleep(candidate.retryBackoffMs * attempt);
          continue;
        }
        // Retries exhausted for this candidate → trip breaker, fail over.
        candidate.breaker.recordFailure();
      }
    }
  }

  throw (
    lastError ??
    new PaymentProviderError(
      PaymentErrorCode.PROVIDER_UNAVAILABLE,
      'All payment providers failed.',
      'orchestrator',
    )
  );
}
