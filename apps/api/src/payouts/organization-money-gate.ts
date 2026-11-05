import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OrganizationStatus } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * A suspended organizer cannot move money out, or change where it goes.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * Suspension stopped new sales (see the booking path) and nothing else. The organizer could
 * still raise a payout of the money already taken, and still replace the bank account it would
 * be paid into. Those are the two things a fraud hold exists to stop: the usual reason to
 * suspend a seller is a doubt about who they are or where the money is going, and "change the
 * account, then raise a payout" is exactly the move that doubt is about.
 *
 * Reads stay open. The organizer can see what they are owed and what is on file, and staff can
 * still decide, verify and pay through their own routes - this blocks the ORGANIZER's writes
 * and the automatic run, not finance's judgement.
 *
 * Only SUSPENDED is blocked. PENDING organizers fill their bank details in before review as
 * part of onboarding, and a REJECTED one can be approved later; neither has sales to pay out.
 */
export const SUSPENDED_PAYOUT_MESSAGE =
  'This organizer is suspended, so payouts cannot be raised. Contact support to find out more.';
export const SUSPENDED_BANK_MESSAGE =
  'This organizer is suspended, so bank details cannot be changed. Contact support to find out more.';

export async function assertOrganizationMayMoveMoney(
  db: Pick<Prisma.TransactionClient, 'organization'>,
  organizationId: string,
  message: string,
): Promise<void> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { status: true },
  });
  if (org?.status === OrganizationStatus.SUSPENDED) {
    throw new AppException(ErrorCodes.FORBIDDEN, message, HttpStatus.FORBIDDEN, {
      organizationStatus: org.status,
    });
  }
}
