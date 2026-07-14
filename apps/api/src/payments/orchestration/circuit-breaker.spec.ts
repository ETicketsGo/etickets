import { CircuitBreaker } from './circuit-breaker';

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and short-circuits attempts', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => t });
    expect(cb.canAttempt()).toBe(true);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canAttempt()).toBe(true); // 2 < 3
    cb.recordFailure();
    expect(cb.canAttempt()).toBe(false); // tripped
    expect(cb.currentState()).toBe('OPEN');
  });

  it('half-opens after the cooldown, then closes on a successful probe', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => t });
    cb.recordFailure();
    expect(cb.canAttempt()).toBe(false);
    t = 500;
    expect(cb.currentState()).toBe('HALF_OPEN');
    expect(cb.canAttempt()).toBe(true);
    cb.recordSuccess();
    expect(cb.currentState()).toBe('CLOSED');
  });

  it('re-opens immediately when the half-open probe fails', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => t });
    cb.recordFailure();
    t = 500;
    expect(cb.currentState()).toBe('HALF_OPEN');
    cb.recordFailure();
    expect(cb.currentState()).toBe('OPEN');
    t = 600; // not yet cooled down again
    expect(cb.canAttempt()).toBe(false);
  });

  it('a success resets the failure count', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => t });
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.canAttempt()).toBe(true); // count was reset, so 1 < 2
  });
});
