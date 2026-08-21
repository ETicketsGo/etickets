import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
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
  async notifyAdmins(type: NotificationType, payload: Record<string, unknown>): Promise<number> {
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
            .send({ type, userId: a.id, toEmail: a.email, payload })
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
   * Notify an organization's owners — the reply half of an approval decision.
   *
   * Owners rather than every member: a decision about the business belongs to whoever runs
   * it, and copying in every check-in staffer would train people to ignore the channel.
   */
  async notifyOrganizationOwners(
    organizationId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
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
      await Promise.all(
        members.map((m) =>
          this.notifications
            .send({ type, userId: m.user.id, toEmail: m.user.email, payload })
            .catch((err) =>
              this.logger.warn(`${type}: could not notify owner ${m.user.id}: ${err}`),
            ),
        ),
      );
      return members.length;
    } catch (err) {
      this.logger.error(`${type}: owner fan-out failed entirely: ${err}`);
      return 0;
    }
  }
}
