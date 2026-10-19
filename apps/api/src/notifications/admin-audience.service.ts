import { Injectable, Logger } from '@nestjs/common';
import { Role, permissionsFor, type AdminPermission } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from './notification.service';
import type { NotificationType } from '@eticketsgo/shared-types';

/**
 * Notifying the people who approve things.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 * Until now every notification was addressed to ONE known recipient — a booking's buyer, a
 * ticket's holder. Approvals are the opposite shape: an organization registers, an event is
 * submitted, and the audience is "whoever can act on it", which nothing in the system could
 * express. So both events happened silently and sat in a queue nobody was told about.
 *
 * ── WHY FAN-OUT, NOT A SHARED MAILBOX ─────────────────────────────────────────────
 * Each admin gets their own notification, so it reaches their in-app inbox and their
 * devices, and one admin reading it does not make it vanish for the others. A single
 * `admin@` address would deliver email and nothing else, and would tell us nothing about
 * who saw what.
 *
 * ── WHY FAILURES ARE SWALLOWED ────────────────────────────────────────────────────
 * These calls sit inside the request that registers an organization or submits an event.
 * A mail outage must not fail that request and lose the registration — the work is done and
 * durable by then, and the queue is still visible in the admin console. Logged loudly so a
 * silent notification outage is not silent in the logs too.
 */
@Injectable()
export class AdminAudienceService {
  private readonly logger = new Logger(AdminAudienceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /** Every active platform admin, as notification recipients. */
  async admins(): Promise<{ id: string; email: string }[]> {
    return this.prisma.user.findMany({
      where: {
        // A suspended or deleted admin must not be paged.
        status: 'ACTIVE',
        OR: [{ roles: { has: Role.ADMIN } }, { roles: { has: Role.SUPER_ADMIN } }],
      },
      select: { id: true, email: true },
    });
  }

  /**
   * Send one notification to every admin. Never throws.
   *
   * Returns how many were notified so a caller can log it; zero is worth noticing, because
   * an approval queue with no reviewers is a queue nothing ever leaves.
   */
  async notifyAdmins(
    type: NotificationType,
    payload: Record<string, unknown>,
    /**
     * `intentKey` collapses repeats: notifications sharing one are sent once per admin. Used to
     * turn a per-event email into at most one per window.
     */
    options: { intentKey?: string } = {},
  ): Promise<number> {
    try {
      const admins = await this.admins();
      if (admins.length === 0) {
        this.logger.warn(
          `${type}: no active admin to notify — this item will wait in the review queue unseen.`,
        );
        return 0;
      }
      await Promise.all(
        admins.map((a) =>
          this.notifications
            .send({
              type,
              userId: a.id,
              toEmail: a.email,
              payload,
              ...(options.intentKey ? { intentKey: options.intentKey } : {}),
            })
            .catch((err) => this.logger.warn(`${type}: could not notify admin ${a.id}: ${err}`)),
        ),
      );
      return admins.length;
    } catch (err) {
      this.logger.error(`${type}: admin fan-out failed entirely: ${err}`);
      return 0;
    }
  }

  /**
   * Every active admin who holds ALL of `required`, as the permission guard computes it (a super
   * admin holds everything). For a queue only some staff can work: paging somebody about work
   * their account would be refused for teaches them to ignore the channel.
   */
  async adminsHolding(
    required: readonly AdminPermission[],
  ): Promise<{ id: string; email: string }[]> {
    const staff = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ roles: { has: Role.ADMIN } }, { roles: { has: Role.SUPER_ADMIN } }],
      },
      select: { id: true, email: true, roles: true, adminGrants: { select: { permission: true } } },
    });
    return staff
      .filter((u) => {
        const held = permissionsFor(
          u.roles,
          u.adminGrants.map((g) => g.permission as AdminPermission),
        );
        return required.every((p) => held.has(p));
      })
      .map((u) => ({ id: u.id, email: u.email }));
  }

  /**
   * `notifyAdmins`, narrowed to the staff who can act: those holding every capability in
   * `required`, less anybody `skip` rules out (for a maker-checker queue, the maker). Never
   * throws, and returns how many were notified - zero is logged, because a queue whose only
   * possible reviewers were all skipped is one nothing ever leaves.
   */
  async notifyAdminsHolding(
    required: readonly AdminPermission[],
    type: NotificationType,
    payload: Record<string, unknown>,
    options: { skip?: (userId: string) => boolean } = {},
  ): Promise<number> {
    try {
      const skip = options.skip;
      const all = await this.adminsHolding(required);
      const recipients = skip ? all.filter((a) => !skip(a.id)) : all;
      if (recipients.length === 0) {
        this.logger.warn(
          `${type}: no active admin holding ${required.join('+')} who may act on it - this item will wait in the queue unseen.`,
        );
        return 0;
      }
      await Promise.all(
        recipients.map((a) =>
          this.notifications
            .send({ type, userId: a.id, toEmail: a.email, payload })
            .catch((err) => this.logger.warn(`${type}: could not notify admin ${a.id}: ${err}`)),
        ),
      );
      return recipients.length;
    } catch (err) {
      this.logger.error(`${type}: admin fan-out failed entirely: ${err}`);
      return 0;
    }
  }

  /**
   * Notify an organization's owners — the reply half of an approval decision.
   *
   * Owners rather than every member: a decision about the business belongs to whoever runs
   * it, and copying in every check-in staffer would train people to ignore the channel.
   */
  async notifyOrganizationOwners(
    organizationId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    /**
     * `skip` leaves out an owner who has already been told this some other way - for the
     * sellability sweep, by a message written before its dedupe key took its current shape.
     * A skipped owner is not counted as notified.
     */
    options: { skip?: (userId: string) => boolean } = {},
  ): Promise<number> {
    try {
      const members = await this.prisma.organizationMember.findMany({
        where: { organizationId, role: Role.ORGANIZER_OWNER },
        select: { user: { select: { id: true, email: true } } },
      });
      if (members.length === 0) {
        this.logger.warn(`${type}: organization ${organizationId} has no owner to notify.`);
        return 0;
      }
      const skip = options.skip;
      const recipients = skip ? members.filter((m) => !skip(m.user.id)) : members;
      await Promise.all(
        recipients.map((m) =>
          this.notifications
            .send({ type, userId: m.user.id, toEmail: m.user.email, payload })
            .catch((err) =>
              this.logger.warn(`${type}: could not notify owner ${m.user.id}: ${err}`),
            ),
        ),
      );
      return recipients.length;
    } catch (err) {
      this.logger.error(`${type}: owner fan-out failed entirely: ${err}`);
      return 0;
    }
  }
}
