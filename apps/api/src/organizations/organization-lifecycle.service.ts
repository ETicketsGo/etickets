import { HttpStatus, Injectable } from '@nestjs/common';
import { OrganizationStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { organizationReadiness, readinessSummary } from './organization-readiness';

/**
 * Stopping an organizer, and removing one.
 *
 * ── WHY SUSPENSION HAD TO BE BUILT BEFORE DELETION ─────────────────────────────────
 * Asked for: a way to delete an organizer from the admin console. Most of the organizers
 * somebody wants gone cannot be deleted and should not be - they have taken money, issued
 * tickets and owe refunds, and the records of that are what answer a chargeback six months
 * later. What the person actually needs in that case is "stop them selling now".
 *
 * `SUSPENDED` already existed in the schema and nothing ever wrote it, so a suspend button
 * would have been a promise the platform did not keep: a suspended organizer's events stayed
 * on sale. Suspension now stops new sales and new publishing, which is what makes it a real
 * answer and deletion an unusual one.
 *
 * ── WHAT DELETION REFUSES ──────────────────────────────────────────────────────────
 * Any booking at all, of any status. A cancelled booking and an expired hold are both
 * records of somebody's attempt to buy, and a refund, a chargeback or a tax question can
 * arrive against them long after. The same rule the organizer's own event delete follows.
 */
@Injectable()
export class OrganizationLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Stop an organizer selling, or let them start again.
   *
   * Reversible on purpose: most suspensions are a question - an unanswered compliance
   * request, a complaint being looked into - and the answer is often "carry on".
   */
  async setSuspended(admin: RequestUser, orgId: string, suspended: boolean, reason?: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, status: true },
    });
    if (!org) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    }

    if (suspended && !reason?.trim()) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Say why you are suspending them. Support and the organizer both have to be able to read it later.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (suspended && org.status === OrganizationStatus.SUSPENDED) return org;
    if (!suspended && org.status !== OrganizationStatus.SUSPENDED) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This organizer is ${org.status.toLowerCase()}, not suspended.`,
        HttpStatus.CONFLICT,
      );
    }

    /*
      Reinstating returns them to APPROVED rather than to whatever they were before. The only
      organizations that can be suspended are ones that were selling, and a suspension is not
      a route back to PENDING - that would put them through review again for something the
      platform did to them.
    */
    const updated = await this.prisma.organization.update({
      where: { id: orgId },
      data: {
        status: suspended ? OrganizationStatus.SUSPENDED : OrganizationStatus.APPROVED,
      },
    });

    await this.audit.record({
      actorUserId: admin.id,
      organizationId: orgId,
      action: suspended ? 'ORGANIZATION_SUSPENDED' : 'ORGANIZATION_REINSTATED',
      entityType: 'Organization',
      entityId: orgId,
      metadata: { previousStatus: org.status, reason: reason?.trim() ?? null },
    });
    return updated;
  }

  /**
   * What this organizer still has to tell us, and what each gap costs them.
   *
   * One list, read by both consoles: the organizer sees their own to-do and an admin sees
   * what to chase. Computed from the organization row plus whether a bank account exists,
   * which is the only fact that does not live on it.
   */
  async readiness(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        status: true,
        legalName: true,
        legalEntityType: true,
        registeredCountry: true,
        registeredAddressLine1: true,
        registeredCity: true,
        taxRegistrationNumber: true,
        financeContactEmail: true,
        grievanceOfficerName: true,
        grievanceOfficerEmail: true,
        contactEmail: true,
        logoUrl: true,
        description: true,
      },
    });
    if (!org) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    }
    const accounts = await this.prisma.organizerPayoutAccount.findMany({
      where: { organizationId: orgId },
      select: { verifiedAt: true },
    });

    const items = organizationReadiness({
      ...org,
      hasPayoutAccount: accounts.length > 0,
      payoutAccountVerified: accounts.some((a) => a.verifiedAt !== null),
    });
    return { items, summary: readinessSummary(items) };
  }

  /**
   * What stands in the way of deleting this organization, in the words an admin needs.
   *
   * Counted rather than described vaguely: "3 bookings" is something a person can go and
   * look at, and "cannot be deleted" is not.
   */
  async deletionBlockers(orgId: string): Promise<string[]> {
    const [bookings, payouts, settlements] = await Promise.all([
      this.prisma.booking.count({ where: { organizationId: orgId } }),
      this.prisma.payout.count({ where: { organizationId: orgId } }),
      this.prisma.settlement.count({ where: { organizationId: orgId } }),
    ]);

    const blockers: string[] = [];
    if (bookings > 0) {
      blockers.push(`${bookings} booking${bookings === 1 ? '' : 's'}`);
    }
    if (payouts > 0) {
      blockers.push(`${payouts} payout${payouts === 1 ? '' : 's'}`);
    }
    if (settlements > 0) {
      blockers.push(`${settlements} settlement record${settlements === 1 ? '' : 's'}`);
    }
    return blockers;
  }

  /**
   * Remove an organization that never traded.
   *
   * The common real case: a duplicate somebody registered twice, or a test organization from
   * a demo. Everything it owns goes with it - events, venues, memberships, invitations - and
   * every one of those is cascade-deleted by the schema, so this is one statement rather than
   * a list that goes stale the next time a table is added.
   */
  async remove(admin: RequestUser, orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!org) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    }

    const blockers = await this.deletionBlockers(orgId);
    if (blockers.length > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This organizer has ${blockers.join(', ')}, which are records somebody may need long ` +
          `after they stop selling - a refund, a chargeback, a tax question. Suspend them ` +
          `instead, which stops their sales immediately and can be undone.`,
        HttpStatus.CONFLICT,
        { blockers },
      );
    }

    /*
      Recorded BEFORE the delete: the audit row names the organization, and after the delete
      there is nothing left to read a name from. The row itself survives - an audit log whose
      entries vanish with what they describe is not an audit log.
    */
    await this.audit.record({
      actorUserId: admin.id,
      action: 'ORGANIZATION_DELETED',
      entityType: 'Organization',
      entityId: orgId,
      metadata: { name: org.name, slug: org.slug, status: org.status },
    });

    await this.prisma.$transaction(async (tx) => {
      // Asked again inside the transaction: a booking can land between the check and here.
      const [bookings] = await Promise.all([
        tx.booking.count({ where: { organizationId: orgId } }),
      ]);
      if (bookings > 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'A booking arrived while this was being deleted. Nothing was removed.',
          HttpStatus.CONFLICT,
        );
      }
      await tx.organization.delete({ where: { id: orgId } });
    });

    return { deleted: true, name: org.name };
  }
}
