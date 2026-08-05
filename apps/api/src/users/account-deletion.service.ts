import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { MemberStatus, Role, UserStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * Self-service account deletion.
 *
 * ── WHY THIS ANONYMISES RATHER THAN HARD-DELETES ──────────────────────────────────
 * Bookings, tickets, check-ins, payments, refunds, settlements and audit entries all
 * reference the user, and every one of them is a record the business is required to
 * keep: GST and Companies Act retention on financial records, chargeback windows on
 * payments, and fraud/dispute history. `DELETE FROM users` would either fail on those
 * foreign keys or silently orphan the financial history behind them.
 *
 * So the row survives with its identifiers and loses its person. What is left is a
 * booking that says "a customer bought two tickets for ₹1,660 on this date" — which is
 * what an auditor needs — attached to an account that no longer names anybody.
 *
 * ── WHAT IS ACTUALLY REMOVED ──────────────────────────────────────────────────────
 * Hard-deleted (no retention basis, no downstream references):
 *   - refresh tokens        → every session dies immediately
 *   - push subscriptions    → the device stops receiving anything
 *   - registered devices    → mobile push tokens revoked
 *   - notification preferences
 *   - notification history  → delivered messages contain event and booking detail
 *   - reviews               → public content authored by a person, not a business record
 *
 * Anonymised in place (referenced by records that must be kept):
 *   - user.email            → deleted+<id>@deleted.invalid  (frees the real address for
 *                             re-registration, and `.invalid` is reserved by RFC 2606 so
 *                             it can never be routed anywhere)
 *   - user.fullName         → "Deleted user"
 *   - user.passwordHash     → a fresh hash of an unguessable value, so the column stays
 *                             a valid bcrypt hash for any code that reads it while
 *                             matching no password that can ever be typed
 *   - booking.buyerName / buyerEmail → the PII on retained financial rows
 *
 * Left untouched deliberately: booking amounts, currencies, references, payment and
 * settlement rows, ticket serials, check-in facts. Those are the records being retained.
 *
 * ── ORGANIZERS ────────────────────────────────────────────────────────────────────
 * A sole active OWNER of an organization cannot delete their account. Doing so would
 * strand the organization's events, payouts and staff with nobody able to administer
 * them, and would mean a customer-facing action silently damaging a business. They are
 * told to transfer ownership first. Non-owner memberships are simply revoked.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Delete the caller's account.
   *
   * IDEMPOTENT. Calling it again on an already-deleted account returns the same success
   * result rather than a 404 — a mobile client that retries after a dropped response
   * must not be told its deletion failed when it succeeded.
   */
  async deleteMe(
    userId: string,
    options: { reason?: string; ip?: string; userAgent?: string } = {},
  ): Promise<{ status: 'DELETED'; deletedAt: string; alreadyDeleted: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        status: true,
        memberships: { select: { organizationId: true, role: true, status: true } },
      },
    });

    if (!user) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'User not found.', HttpStatus.NOT_FOUND);
    }

    if (user.status === UserStatus.DELETED) {
      return { status: 'DELETED', deletedAt: new Date().toISOString(), alreadyDeleted: true };
    }

    await this.assertNotSoleOrganizationOwner(user.memberships);

    const deletedAt = new Date();
    const anonymousEmail = `deleted+${user.id}@deleted.invalid`;
    // A real bcrypt hash of a value nobody holds. Storing a sentinel like "DELETED"
    // would leave a column that bcrypt.compare cannot process, which turns a login
    // attempt into a 500 instead of a clean rejection.
    const unusablePasswordHash = await bcrypt.hash(
      `deleted:${user.id}:${deletedAt.toISOString()}:${Math.random()}`,
      10,
    );

    await this.prisma.$transaction(async (tx) => {
      // Sessions first. If anything later in the transaction fails the whole thing
      // rolls back, but ordering it first means the intent is unambiguous in review.
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.pushSubscription.deleteMany({ where: { userId } });
      // Mobile push devices. The FK cascades, but the row is removed explicitly here so
      // revocation is part of the same transaction rather than a side effect of a
      // delete that never happens (the user row is anonymised, not deleted).
      await tx.userDevice.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.review.deleteMany({ where: { userId } });

      // Membership rows go; the organizations themselves are untouched.
      await tx.organizationMember.deleteMany({ where: { userId } });

      // Financial records stay; the personal data on them does not.
      await tx.booking.updateMany({
        where: { userId },
        data: { buyerName: 'Deleted user', buyerEmail: anonymousEmail },
      });

      /**
       * Tickets assigned to this person lose the attribution and the personal fields on
       * them, but keep their serial, status and validity: the ticket is still a valid
       * entitlement and somebody may be about to walk through a gate with it. Deleting
       * an account is not the same as cancelling the tickets it bought.
       */
      await tx.ticket.updateMany({
        where: { attendeeUserId: userId },
        data: {
          attendeeUserId: null,
          holderName: null,
          holderEmail: null,
          attendeePhone: null,
          attendeeCompany: null,
          attendeeDesignation: null,
          attendeeStudentId: null,
          attendeeMemberId: null,
          attendeeCustomFields: Prisma.DbNull,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          status: UserStatus.DELETED,
          email: anonymousEmail,
          fullName: 'Deleted user',
          passwordHash: unusablePasswordHash,
          roles: [Role.CUSTOMER],
        },
      });

      /**
       * Audit entry with NO personal data in it.
       *
       * The obligation is to show that a deletion happened, was requested by the account
       * holder, and when. Recording the old email here would defeat the deletion — the
       * audit log is exactly the sort of long-lived table that a subject-access request
       * would later surface. The user id is enough to tie it to the (now anonymous) row.
       */
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'USER_SELF_DELETED',
          entityType: 'User',
          entityId: userId,
          metadata: {
            // A free-text reason is user-supplied and could contain anything, so it is
            // bounded and stored only as a coarse category when recognised.
            reason: normaliseReason(options.reason),
            ip: options.ip ?? null,
            userAgent: options.userAgent?.slice(0, 200) ?? null,
          },
        },
      });
    });

    // The identifier only — never the email that was just anonymised.
    this.logger.log(`Account deleted (self-service): user=${userId}`);

    return { status: 'DELETED', deletedAt: deletedAt.toISOString(), alreadyDeleted: false };
  }

  /**
   * Refuse when the caller is the only active owner of an organization.
   *
   * Checked per organization: someone may own one and merely staff another.
   */
  private async assertNotSoleOrganizationOwner(
    memberships: { organizationId: string; role: Role; status: MemberStatus }[],
  ): Promise<void> {
    const ownedOrgIds = memberships
      .filter((m) => m.role === Role.ORGANIZER_OWNER && m.status === MemberStatus.ACTIVE)
      .map((m) => m.organizationId);

    if (ownedOrgIds.length === 0) return;

    const otherOwners = await this.prisma.organizationMember.groupBy({
      by: ['organizationId'],
      where: {
        organizationId: { in: ownedOrgIds },
        role: Role.ORGANIZER_OWNER,
        status: MemberStatus.ACTIVE,
      },
      _count: { _all: true },
    });

    const countByOrg = new Map(otherOwners.map((row) => [row.organizationId, row._count._all]));
    const stranded = ownedOrgIds.filter((id) => (countByOrg.get(id) ?? 0) <= 1);

    if (stranded.length > 0) {
      throw new AppException(
        ErrorCodes.ACCOUNT_DELETION_BLOCKED,
        'You are the only owner of an organization. Transfer ownership to another owner before deleting your account.',
        HttpStatus.CONFLICT,
        { organizationCount: stranded.length },
      );
    }
  }
}

/**
 * Reduce a free-text reason to a known category, or drop it.
 *
 * The reason is optional product analytics, not a record worth keeping verbatim: a user
 * typing their grievance into it would have that text retained in an audit table that
 * survives the deletion they just asked for.
 */
const KNOWN_REASONS = new Set([
  'NOT_USING',
  'PRIVACY',
  'TOO_MANY_EMAILS',
  'FOUND_ALTERNATIVE',
  'OTHER',
]);

function normaliseReason(reason?: string): string | null {
  if (!reason) return null;
  const upper = reason.trim().toUpperCase();
  return KNOWN_REASONS.has(upper) ? upper : 'OTHER';
}
