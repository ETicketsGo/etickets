import { AppException } from '../../common/errors';
import {
  CompensationState as S,
  assertCompensationTransition,
  canCompensationTransition,
  isTerminalCompensation,
} from './compensation-state';
import { choosePaymentCompensation } from './payment-capability';
import { CompensationType } from './compensation-types';

describe('compensation state machine', () => {
  it('models the safe execution loop', () => {
    expect(canCompensationTransition(S.PLANNED, S.READY)).toBe(true);
    expect(canCompensationTransition(S.READY, S.PROCESSING)).toBe(true);
    expect(canCompensationTransition(S.PROCESSING, S.COMPLETED)).toBe(true);
    expect(canCompensationTransition(S.PROCESSING, S.RETRYABLE_FAILURE)).toBe(true);
    expect(canCompensationTransition(S.RETRYABLE_FAILURE, S.READY)).toBe(true);
    expect(canCompensationTransition(S.PROCESSING, S.DEAD_LETTERED)).toBe(true);
    expect(canCompensationTransition(S.PROCESSING, S.MANUAL_REVIEW)).toBe(true);
  });

  it('never reopens a terminal compensation and treats same-state as idempotent', () => {
    for (const t of [S.COMPLETED, S.DEAD_LETTERED, S.CANCELLED]) {
      expect(isTerminalCompensation(t)).toBe(true);
      expect(() => assertCompensationTransition(t, S.READY)).toThrow(AppException);
      expect(() => assertCompensationTransition(t, t)).not.toThrow(); // idempotent
    }
  });

  it('rejects illegal jumps', () => {
    expect(() => assertCompensationTransition(S.PLANNED, S.COMPLETED)).toThrow(AppException);
    expect(() => assertCompensationTransition(S.READY, S.DEAD_LETTERED)).toThrow(AppException);
  });
});

describe('choosePaymentCompensation', () => {
  it('voids an authorized-not-captured payment on an auth/capture provider', () => {
    expect(
      choosePaymentCompensation(
        { captured: false },
        { supportsAuthorizeCapture: true, supportsRefund: true },
      ),
    ).toBe(CompensationType.PAYMENT_VOID);
  });

  it('refunds a captured payment', () => {
    expect(
      choosePaymentCompensation(
        { captured: true },
        { supportsAuthorizeCapture: true, supportsRefund: true },
      ),
    ).toBe(CompensationType.PAYMENT_REFUND);
  });

  it('refunds when the provider does not distinguish auth/capture', () => {
    expect(
      choosePaymentCompensation(
        { captured: false },
        { supportsAuthorizeCapture: false, supportsRefund: true },
      ),
    ).toBe(CompensationType.PAYMENT_REFUND);
  });

  it('never guesses when the capture state is unknown', () => {
    expect(
      choosePaymentCompensation({}, { supportsAuthorizeCapture: true, supportsRefund: true }),
    ).toBe(CompensationType.MANUAL_REVIEW);
  });
});
