import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { NotificationType, Role, isReservedEmail } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { EmailChannel } from '../notifications/channels/email.channel';
import { NotificationTemplateService } from '../notifications/templates/notification-template.service';
import { messageContentLoggable } from '../notifications/channels/transports/content-logging';

/**
 * A phone-only account adding an email address it has PROVED it receives mail at.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * A phone-only customer can become an organizer, and everything the platform tells an
 * organizer - approved, rejected, a payout, a dispute - goes to the owner's account email
 * (`AdminAudienceService.notifyOrganizationOwners`). A phone-only account's email is a
 * placeholder the email channel refuses to send to, so that organizer heard nothing at all.
 * This lets them add a real address during onboarding, without ever being asked for a password.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────────────
 *   - Only for an account whose email is still the placeholder. An account that has a real
 *     address keeps it; changing an address is a different feature with different risks.
 *   - The code goes to the address, is hashed at rest, dies in 10 minutes, survives 5 wrong
 *     guesses, and asking again kills the last one - the phone code's rules exactly.
 *   - It is sent through the email channel DIRECTLY, never `NotificationService.send`, which
 *     would persist the live code in a Notification row (the reason PhoneOtpService does the same
 *     with SMS). In a deployed environment whose email provider is `log`, nothing is sent and the
 *     person is told so, instead of waiting for a code that cannot arrive.
 *   - One address, one account. An address that already belongs to another account is refused
 *     - the same answer the email sign-up form already gives, so the duplicate rule is unchanged.
 *   - Once proved, the address becomes the account's email (with `emailVerifiedAt`) and the
 *     contact email of any organization this account owns that has none.
 */

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
/** Per account: one code a minute, five an hour. Cheap for a person, useless for a flood. */
const RESEND_COOLDOWN_MS = 60_000;
const MAX_PER_HOUR = 5;

interface RequestMeta {
  ip?: string;
}

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailChannel,
    private readonly templates: NotificationTemplateService,
    private readonly config: ConfigService,
  ) {}

  async requestCode(
    userId: string,
    rawEmail: string,
    meta: RequestMeta,
  ): Promise<{ sent: true; expiresInMinutes: number }> {
    const address = normaliseEmail(rawEmail);
    await this.assertMayAdd(userId, address);
    return this.issueCode(userId, address, 'add', meta);
  }

  /**
   * Send a code to the address the account ALREADY has, to prove it is theirs.
   *
   * Owner decision (2026-10-26): a team invitation is accepted only by the invited person, with
   * their email proved. Every account made before `emailVerifiedAt` existed has it null, so this
   * is how such an account proves it - the same code, the same limits, the same refusal when mail
   * cannot be sent. Also used, without a session, for an account an invitation created (the
   * caller has already tied the request to that invitation's token).
   */
  async requestOwnAddressCode(
    userId: string,
    meta: RequestMeta,
  ): Promise<{ sent: true; expiresInMinutes: number; email: string }> {
    const address = await this.ownAddress(userId);
    const sent = await this.issueCode(userId, address, 'confirm', meta);
    return { ...sent, email: address };
  }

  /** Spend a code sent by {@link requestOwnAddressCode}: the account's email is now proved. */
  async confirmOwnAddress(
    userId: string,
    code: string,
    meta: RequestMeta,
  ): Promise<{ email: string; emailVerifiedAt: Date }> {
    const address = await this.ownAddress(userId);
    await this.spendCode(userId, address, code);
    const emailVerifiedAt = new Date();
    /*
      Only if the address is still the one the code went to: an account whose email changed
      between the code and now has proved nothing about its new address.
    */
    const updated = await this.prisma.user.updateMany({
      where: { id: userId, email: { equals: address, mode: 'insensitive' } },
      data: { emailVerifiedAt },
    });
    if (updated.count === 0) throw codeRejected();
    await this.audit.record({
      actorUserId: userId,
      action: 'ACCOUNT_EMAIL_CONFIRMED',
      entityType: 'User',
      entityId: userId,
      ip: meta.ip ?? null,
    });
    return { email: address, emailVerifiedAt };
  }

  /** The account's own, real address - or a refusal that says why there is nothing to prove. */
  private async ownAddress(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This account cannot be changed.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (isReservedEmail(user.email)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Your account has no email address yet. Add one from your profile first.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return normaliseEmail(user.email);
  }

  /** Rate-limit, mint, store hashed, deliver - or spend it and say mail cannot be sent. */
  private async issueCode(
    userId: string,
    address: string,
    purpose: 'add' | 'confirm',
    meta: RequestMeta,
  ): Promise<{ sent: true; expiresInMinutes: number }> {
    const since = new Date(Date.now() - 60 * 60_000);
    const recent = await this.prisma.emailVerificationCode.findMany({
      where: { userId, createdAt: { gt: since } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (
      recent.length >= MAX_PER_HOUR ||
      (recent[0] && Date.now() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS)
    ) {
      throw new AppException(
        ErrorCodes.RATE_LIMITED,
        'Please wait a minute before asking for another code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.emailVerificationCode.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const row = await this.prisma.emailVerificationCode.create({
      data: {
        userId,
        email: address,
        codeHash: await bcrypt.hash(code, 10),
        expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
        requestedIp: meta.ip ?? null,
      },
      select: { id: true },
    });

    const payload = { code, minutes: String(CODE_TTL_MINUTES), purpose };
    const rendered = this.templates.render(NotificationType.EMAIL_VERIFICATION_CODE, 'en', payload);
    let provider: string | undefined;
    let skipped = false;
    try {
      const outcome = await this.email.deliver({
        type: NotificationType.EMAIL_VERIFICATION_CODE,
        channel: 'email',
        locale: 'en',
        toEmail: address,
        userId,
        subject: rendered.subject,
        body: rendered.body,
        payload,
      });
      provider = outcome?.provider;
      skipped = outcome?.skipped === true;
    } catch (err) {
      this.logger.error(`email code not delivered for user ${userId}: ${(err as Error).message}`);
    }
    /*
      The same rule as the phone code: in LOCAL/DEV the console is the delivery channel; anywhere
      else `log`, a skip or a failure means nobody will receive it, so the code is spent and the
      person is told, rather than shown "code sent" for a message that never went.
    */
    const undelivered = !provider || skipped || provider === 'log';
    if (undelivered && !messageContentLoggable(this.config)) {
      await this.prisma.emailVerificationCode
        .updateMany({ where: { id: row.id }, data: { consumedAt: new Date() } })
        .catch(() => undefined);
      throw new AppException(
        ErrorCodes.EMAIL_UNAVAILABLE,
        purpose === 'add'
          ? "We can't send email right now. You can add your email address later from your profile."
          : "We can't send email right now, so we can't confirm your email address. Please try again later.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    await this.audit.record({
      actorUserId: userId,
      action: 'ACCOUNT_EMAIL_CODE_SENT',
      entityType: 'User',
      entityId: userId,
      metadata: { purpose },
      ip: meta.ip ?? null,
    });
    return { sent: true, expiresInMinutes: CODE_TTL_MINUTES };
  }

  async verify(
    userId: string,
    rawEmail: string,
    code: string,
    meta: RequestMeta,
  ): Promise<{ email: string }> {
    const address = normaliseEmail(rawEmail);
    await this.spendCode(userId, address, code);

    // Checked again: the account may have gained an address, or the address an account.
    await this.assertMayAdd(userId, address);
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { email: address, emailVerifiedAt: new Date() },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') throw addressTaken();
      throw err;
    }
    /*
      The organization's public contact address, where the owner left it blank (a phone-only
      owner had nothing to put there). Never overwrites one somebody typed.
    */
    await this.prisma.organization.updateMany({
      where: {
        contactEmail: null,
        members: { some: { userId, role: Role.ORGANIZER_OWNER, status: 'ACTIVE' } },
      },
      data: { contactEmail: address },
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'ACCOUNT_EMAIL_ADDED',
      entityType: 'User',
      entityId: userId,
      metadata: { verified: true },
      ip: meta.ip ?? null,
    });
    return { email: address };
  }

  /**
   * Spend the live code for this account and address, or refuse with ONE answer for every
   * reason (none, wrong, expired, too many guesses) so a guesser learns nothing.
   */
  private async spendCode(userId: string, address: string, code: string): Promise<void> {
    const rejected = codeRejected;
    const row = await this.prisma.emailVerificationCode.findFirst({
      where: { userId, email: address, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw rejected();
    // The guess is paid for before it is checked (see PhoneOtpService.consumeCode).
    const claimed = await this.prisma.emailVerificationCode.updateMany({
      where: { id: row.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      await this.prisma.emailVerificationCode.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      throw rejected();
    }
    if (!(await bcrypt.compare(code, row.codeHash))) throw rejected();
    const spent = await this.prisma.emailVerificationCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (spent.count === 0) throw rejected();
  }

  private async assertMayAdd(userId: string, address: string): Promise<void> {
    if (isReservedEmail(address)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This email address cannot be used.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This account cannot be changed.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!isReservedEmail(user.email)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Your account already has an email address.',
        HttpStatus.CONFLICT,
      );
    }
    const holder = await this.prisma.user.findFirst({
      where: { email: { equals: address, mode: 'insensitive' }, id: { not: userId } },
      select: { id: true },
    });
    if (holder) throw addressTaken();
  }
}

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function addressTaken(): AppException {
  return new AppException(
    ErrorCodes.EMAIL_ALREADY_REGISTERED,
    'An account with this email already exists. Sign in with it, or use a different address.',
    HttpStatus.CONFLICT,
  );
}

function codeRejected(): AppException {
  return new AppException(
    ErrorCodes.INVALID_CREDENTIALS,
    'That code is not valid. Ask for a new one.',
    HttpStatus.BAD_REQUEST,
  );
}
