/**
 * Per-provider circuit breaker (ADR-021). Protects the orchestrator from hammering
 * a provider that is failing: after `failureThreshold` consecutive failures the
 * breaker OPENS and short-circuits attempts for `cooldownMs`; the first attempt
 * after cooldown is allowed through (HALF-OPEN) and either closes the breaker on
 * success or re-opens it on failure.
 *
 * The clock is injected so the state machine is fully unit-testable without timers.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = 'CLOSED';
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(1, opts.failureThreshold);
    this.cooldownMs = Math.max(0, opts.cooldownMs);
    this.now = opts.now ?? Date.now;
  }

  /** Current state, transitioning OPEN→HALF_OPEN once the cooldown has elapsed. */
  currentState(): CircuitState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
    }
    return this.state;
  }

  /** Whether the orchestrator may attempt a call against this provider now. */
  canAttempt(): boolean {
    return this.currentState() !== 'OPEN';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    // A failure while HALF_OPEN immediately re-opens (probe failed).
    if (this.currentState() === 'HALF_OPEN') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  /** Operator control: force the breaker OPEN (activate failover away from it). */
  forceOpen(): void {
    this.trip();
  }

  /** Operator control: reset the breaker to CLOSED (roll failover back). */
  reset(): void {
    this.recordSuccess();
  }

  private trip(): void {
    this.state = 'OPEN';
    this.openedAt = this.now();
    this.failures = this.failureThreshold;
  }
}
