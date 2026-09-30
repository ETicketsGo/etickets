import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Give the first back-office account its role, where nothing else can.
 *
 * ── THE CIRCLE THIS BREAKS ─────────────────────────────────────────────────────────
 * Exactly two things grant ADMIN: `prisma/seed.ts`, which empties every table and which
 * production refuses outright and should, and `AdminStaffService.grantAdminRole`, which requires
 * an existing admin to call it. So a freshly provisioned production has no administrator and no
 * way to obtain one - the admin console is reachable and nobody can sign in to it. Organizers are
 * fine, because `POST /auth/register` is public; the back office is not.
 *
 * On this platform the seed job is not a way out either: on PROD a db-seed deployment reports
 * SUCCESS and never starts a container. Environment variables demonstrably do work there, so this
 * is driven by one.
 *
 * ── WHY IT CANNOT BE USED TO ESCALATE ──────────────────────────────────────────────
 * Every condition below is a refusal, and the first one closes the door permanently:
 *
 *   - It runs ONLY while the environment has NO admin at all. The moment one exists - including
 *     the one it just made - it does nothing, for ever. It cannot add a second administrator, so
 *     it is not a standing grant of privilege.
 *   - It NEVER creates a user and never sets or sends a password. The person registers themselves
 *     first, exactly as `grantAdminRole` insists, because a password chosen by an administrator is
 *     one the account holder never chose.
 *   - An email that matches no account is left alone and said out loud, rather than being created.
 *
 * It is audit-logged with no actor, because there is no human actor: the deployment did it.
 */
@Injectable()
export class FirstAdminBootstrap implements OnModuleInit {
  private readonly logger = new Logger(FirstAdminBootstrap.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    const email = (this.config.get<string>('ADMIN_BOOTSTRAP_EMAIL') ?? '').trim().toLowerCase();
    if (!email) return;

    try {
      const existingAdmins = await this.prisma.user.count({
        where: { roles: { hasSome: [Role.ADMIN, Role.SUPER_ADMIN] } },
      });
      if (existingAdmins > 0) {
        // The normal state. Not worth a line on every boot.
        return;
      }

      const user = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, roles: true },
      });
      if (!user) {
        this.logger.warn(
          `ADMIN_BOOTSTRAP_EMAIL is set to an address with no account, so this environment still ` +
            `has no administrator. Register that address first, then redeploy.`,
        );
        return;
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: { roles: { set: [...new Set([...user.roles, Role.ADMIN, Role.SUPER_ADMIN])] } },
      });
      await this.audit.record({
        action: 'ADMIN_ROLE_GRANTED',
        entityType: 'User',
        entityId: user.id,
        metadata: { reason: 'first-admin bootstrap', email: user.email },
      });
      // The email is already in the audit row; the log line says what happened without repeating it.
      this.logger.log(
        'This environment had no administrator; the account named by ADMIN_BOOTSTRAP_EMAIL is now one.',
      );
    } catch (err) {
      /*
        Swallowed on purpose. A back-office role is not worth refusing to serve a storefront over,
        and the failure is visible: the console simply cannot be signed in to, which is the state
        this exists to report rather than to hide behind a crash.
      */
      this.logger.warn(
        `First-admin bootstrap failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
}
