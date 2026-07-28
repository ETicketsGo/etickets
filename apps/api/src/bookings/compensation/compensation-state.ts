import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors';

/** Compensation lifecycle states (ADR-043). Mirrors the Prisma `CompensationState` enum. */
export const CompensationState = {
  PLANNED: 'PLANNED',
  READY: 'READY',
  PROCESSING: 'PROCESSING',
  RETRYABLE_FAILURE: 'RETRYABLE_FAILURE',
  COMPLETED: 'COMPLETED',
  DEAD_LETTERED: 'DEAD_LETTERED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  CANCELLED: 'CANCELLED',
} as const;
export type CompensationState = (typeof CompensationState)[keyof typeof CompensationState];

const S = CompensationState;

/** Terminal states — no execution reopens them without an audited admin action. */
export const TERMINAL_COMPENSATION_STATES: ReadonlySet<CompensationState> = new Set([
  S.COMPLETED,
  S.DEAD_LETTERED,
  S.CANCELLED,
]);

/**
 * Guarded transition matrix. A completed compensation is never re-executed; retryable
 * failures loop back to READY; uncertain outcomes go to MANUAL_REVIEW; poison work is
 * dead-lettered. MANUAL_REVIEW may be resolved by an audited admin action.
 */
export const ALLOWED_COMPENSATION_TRANSITIONS: Readonly<
  Record<CompensationState, ReadonlySet<CompensationState>>
> = {
  [S.PLANNED]: new Set([S.READY, S.MANUAL_REVIEW, S.CANCELLED]),
  [S.READY]: new Set([S.PROCESSING, S.MANUAL_REVIEW, S.CANCELLED]),
  [S.PROCESSING]: new Set([S.COMPLETED, S.RETRYABLE_FAILURE, S.MANUAL_REVIEW, S.DEAD_LETTERED]),
  [S.RETRYABLE_FAILURE]: new Set([S.READY, S.MANUAL_REVIEW, S.DEAD_LETTERED]),
  [S.MANUAL_REVIEW]: new Set([S.READY, S.CANCELLED, S.DEAD_LETTERED]),
  [S.COMPLETED]: new Set<CompensationState>(),
  [S.DEAD_LETTERED]: new Set<CompensationState>(),
  [S.CANCELLED]: new Set<CompensationState>(),
};

export function isTerminalCompensation(state: CompensationState): boolean {
  return TERMINAL_COMPENSATION_STATES.has(state);
}

export function canCompensationTransition(from: CompensationState, to: CompensationState): boolean {
  if (from === to) return true; // idempotent re-assertion
  return ALLOWED_COMPENSATION_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertCompensationTransition(from: CompensationState, to: CompensationState): void {
  if (from === to) return;
  if (isTerminalCompensation(from) || !canCompensationTransition(from, to)) {
    throw new AppException(
      'COMPENSATION_INVALID_TRANSITION',
      'This compensation cannot change in the requested way.',
      HttpStatus.CONFLICT,
      { from, to },
    );
  }
}
