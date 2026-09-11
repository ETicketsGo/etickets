import { HttpStatus } from '@nestjs/common';
import { passwordProblems, type PasswordContext } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * Refuse a password the policy does not accept, with the person's own context applied.
 *
 * ── WHY THE SERVER CHECKS AGAIN WHEN THE SCHEMA ALREADY DID ────────────────────────
 * The request schema knows the password and, at registration, the name and email typed
 * beside it. It does not know whose account a reset link or an invitation belongs to — the
 * server does. So the rule that refuses somebody's own name can only be applied here for those
 * two paths, and applying it here for registration too means no caller reaches account
 * creation with a password the policy refuses, whatever validated the request.
 *
 * The error carries the same `fields.password` shape the validation pipe uses, so a client
 * reads one shape whichever of the two refused it.
 */
export function assertAcceptablePassword(password: string, context: PasswordContext): void {
  const problems = passwordProblems(password, context);
  if (problems.length === 0) return;
  throw new AppException(
    ErrorCodes.VALIDATION_FAILED,
    problems[0].message,
    HttpStatus.BAD_REQUEST,
    {
      fields: { password: problems.map((p) => p.message) },
      passwordProblems: problems.map((p) => p.code),
    },
  );
}
