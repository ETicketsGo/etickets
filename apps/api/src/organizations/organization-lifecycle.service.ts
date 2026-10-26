import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, OrganizationStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { organizationReadiness, readinessSummary } from './organization-readiness';
import { organizerActions, type OrganizerActionSummary } from './organizer-actions';
import { revokeReasonEntry } from '../checkins/offline/revocation-reasons';

/** `CheckInDevice.revokeReason` for a device revoked because its organization was suspended. */
export const SUSPENSION_REVOKE_REASON = 'ORGANIZATION_SUSPENDED';

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
    /*
      Only an approved organizer can be suspended. Reinstating returns them to APPROVED (below),
      so suspending one still PENDING review and then reinstating it approved it - past the
      review and the legal identity check, with no decision recorded as an approval. The console
      offered Suspend on a pending organizer, which is how it was found (QA walk, 2026-10-15).
      A pending or rejected organizer cannot sell anyway; there is nothing to suspend.
    */
    if (suspended && org.status !== OrganizationStatus.APPROVED) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This organizer is ${org.status.toLowerCase()}, so they cannot sell and there is nothing to suspend. Approve or reject them instead.`,
        HttpStatus.CONFLICT,
      );
    }
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
    /*
      ── SUSPENSION TAKES THE DOOR PHONES OFF THE DOOR ────────────────────────────────
      Owner decision (2026-10-26): a suspended organization loses check-in authorization.
      Every check-in device it has is REVOKED in the same transaction as the status change,
      and every live offline activation decision with it. A device that is offline right now
      cannot hear this; what bounds it is the ticket list it holds (the offline lease, at most
      the revocation window), and its queued scans are refused when it uploads them.

      Reinstating does NOT bring the devices back. Revoked is final (CheckInDeviceService.
      approve refuses it), so after a reinstatement each phone is registered and approved again
      by a manager - a person decides the phone is trusted, not a side effect of an admin
      lifting a suspension. Scans a revoked phone made while it was cut off are held for
      review, never applied, before and after the reinstatement alike.
    */
    const now = new Date();
    const { updated, deviceIds, activations, stillRevoked } = await this.prisma.$transaction(
      async (tx) => {
        const updated = await tx.organization.update({
          where: { id: orgId },
          data: {
            status: suspended ? OrganizationStatus.SUSPENDED : OrganizationStatus.APPROVED,
          },
        });
        if (!suspended) {
          const stillRevoked = await tx.checkInDevice.count({
            where: { organizationId: orgId, revokeReason: SUSPENSION_REVOKE_REASON },
          });
          return { updated, deviceIds: [] as string[], activations: 0, stillRevoked };
        }
        const devices = await tx.checkInDevice.findMany({
          where: { organizationId: orgId, status: { not: 'REVOKED' } },
          select: { id: true },
        });
        const deviceIds = devices.map((d: { id: string }) => d.id);
        if (deviceIds.length > 0) {
          await tx.checkInDevice.updateMany({
            where: { id: { in: deviceIds } },
            data: {
              status: 'REVOKED',
              revokedAt: now,
              revokeReason: SUSPENSION_REVOKE_REASON,
              revokeReasons: { push: revokeReasonEntry(SUSPENSION_REVOKE_REASON, now) },
            },
          });
        }
        // Already revoked (lost, by hand): the first reason stays and the suspension is appended.
        await tx.checkInDevice.updateMany({
          where: { organizationId: orgId, status: 'REVOKED', id: { notIn: deviceIds } },
          data: { revokeReasons: { push: revokeReasonEntry(SUSPENSION_REVOKE_REASON, now) } },
        });
        const activations = (
          await tx.offlineActivation.updateMany({
            where: { organizationId: orgId, state: 'ACTIVE' },
            data: {
              state: 'REVOKED',
              revokedByUserId: admin.id,
              revokedAt: now,
              revokeReason: 'The organization was suspended.',
            },
          })
        ).count;
        return { updated, deviceIds, activations, stillRevoked: 0 };
      },
    );

    await this.audit.record({
      actorUserId: admin.id,
      organizationId: orgId,
      action: suspended ? 'ORGANIZATION_SUSPENDED' : 'ORGANIZATION_REINSTATED',
      entityType: 'Organization',
      entityId: orgId,
      metadata: {
        previousStatus: org.status,
        reason: reason?.trim() ?? null,
        ...(suspended
          ? { checkInDevicesRevoked: deviceIds.length, offlineActivationsRevoked: activations }
          : { checkInDevicesStillRevoked: stillRevoked }),
      },
    });
    // One row per device too, so each phone's own history says why it stopped.
    for (const id of deviceIds) {
      await this.audit.record({
        actorUserId: admin.id,
        organizationId: orgId,
        action: 'CHECKIN_DEVICE_REVOKED',
        entityType: 'CheckInDevice',
        entityId: id,
        metadata: { reason: SUSPENSION_REVOKE_REASON },
      });
    }
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
   * Everything this organizer still has to do, as one list.
   *
   * Composes `organizationReadiness` with the operational checks the CONSOLE used to make from
   * four separate list endpoints - which is how the dashboard and the Get-started page could
   * disagree about the same question. Completion is decided here, once.
   *
   * Read only, and event sellability is deliberately not part of it: whether a particular event
   * can be sold is answered against that event and stays that way.
   */
  async actions(orgId: string): Promise<OrganizerActionSummary> {
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

    const [accounts, venueCount, teamMemberCount, publishedEventCount, seatingRoomCount] =
      await Promise.all([
        this.prisma.organizerPayoutAccount.findMany({
          where: { organizationId: orgId },
          select: { verifiedAt: true },
        }),
        this.prisma.venue.count({ where: { organizationId: orgId } }),
        // Beyond the sole owner: an organization of one is not a team.
        this.prisma.organizationMember.count({
          where: { organizationId: orgId, role: { not: Role.ORGANIZER_OWNER } },
        }),
        this.prisma.event.count({
          where: { organizationId: orgId, status: EventStatus.PUBLISHED },
        }),
        /*
          Rooms that could actually host reserved seating: the SAME condition
          `EventsService.listSeatingRooms` uses - a screen whose cinema is this organization's,
          with at least one PUBLISHED seat map. Counting a room without one would mark the step
          done while the seating picker still shows nothing.
        */
        this.prisma.screen.count({
          where: {
            cinema: { organizationId: orgId },
            seatMaps: { some: { status: 'PUBLISHED' } },
          },
        }),
      ]);

    return organizerActions(
      orgId,
      {
        ...org,
        hasPayoutAccount: accounts.length > 0,
        payoutAccountVerified: accounts.some(
          (a: { verifiedAt: Date | null }) => a.verifiedAt !== null,
        ),
      },
      { venueCount, seatingRoomCount, teamMemberCount, publishedEventCount },
    );
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
