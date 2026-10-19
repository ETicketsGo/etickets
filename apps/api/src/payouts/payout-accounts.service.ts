import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminPermission, NotificationType, Role } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { currentRequest } from '../common/request-context';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import {
  BankSecretKeyMissing,
  bankKey,
  decryptAccountNumber,
  encryptAccountNumber,
  last4,
} from './bank-secret';
import {
  changedFieldsOf,
  independenceFailure,
  looksLikeAccountNumber,
  reviewStatusOf,
  type PayoutAccountReviewStatus,
} from './payout-account-safety';

/**
 * Where an organizer's money is sent, for as long as a person is the one sending it.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ──────────────────────────────────────────────────
 * It is not a payments integration. Nothing here moves money; it records the destination so
 * that whoever makes the transfer is not chasing it through email. When Razorpay Route or
 * Stripe Connect is switched on, the provider holds the account and this becomes the record
 * of what was used before that.
 *
 * ── WHO SEES WHAT ──────────────────────────────────────────────────────────────────
 * An organizer enters their own account and sees it masked afterwards - they know their own
 * number, and showing it back adds nothing but a screen to shoulder-surf. An admin with
 * PAYOUT_MANAGE can reveal it once, which is written to the audit log with the payout it was
 * revealed for. Nobody else can read it at all.
 */
export interface PayoutAccountView {
  id: string;
  currency: string;
  holderName: string;
  bankName: string;
  bankCode: string;
  /** Only ever the last four digits. The rest never leaves this service unrevealed. */
  accountLast4: string;
  verifiedAt: Date | null;
  updatedAt: Date;
  /** Where the account stands. A saved or changed account is PENDING_VERIFICATION until staff decide. */
  status: PayoutAccountReviewStatus;
  /** Counts saves; a verification names the version it checked. */
  version: number;
  rejectedAt: Date | null;
  /** Why staff turned the details down, in their words. Never contains an account number. */
  rejectionReason: string | null;
}

/** One saved version of an account, masked. There is no field here that could hold a full number. */
export interface PayoutAccountVersionView {
  version: number;
  currency: string;
  holderName: string;
  bankName: string;
  bankCode: string;
  accountLast4: string;
  /** Which fields this save changed: holderName, bankName, bankCode, accountNumber, or `initial`. */
  changedFields: string[];
  status: 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | 'SUPERSEDED';
  savedAt: Date;
  savedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
}

@Injectable()
export class PayoutAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly audience: AdminAudienceService,
  ) {}

  private key(): Buffer | null {
    return bankKey(this.config?.get<string>('PAYOUT_BANK_ENCRYPTION_KEY'));
  }

  private view(row: {
    id: string;
    currency: string;
    holderName: string;
    bankName: string;
    bankCode: string;
    accountLast4: string;
    verifiedAt: Date | null;
    updatedAt: Date;
    rejectedAt: Date | null;
    rejectionReason: string | null;
    version: number;
  }): PayoutAccountView {
    return {
      id: row.id,
      currency: row.currency,
      holderName: row.holderName,
      bankName: row.bankName,
      bankCode: row.bankCode,
      accountLast4: row.accountLast4,
      verifiedAt: row.verifiedAt,
      updatedAt: row.updatedAt,
      status: reviewStatusOf(row),
      version: row.version,
      rejectedAt: row.rejectedAt,
      rejectionReason: row.rejectionReason,
    };
  }

  /**
   * An audit row that says what happened and how it ended, carrying the request's correlation id
   * so it can be matched to the log lines of the same request. Metadata is built by the caller
   * from masked fields only: this method adds nothing from the account itself.
   */
  private async record(
    actorUserId: string,
    organizationId: string,
    entityId: string,
    action: string,
    outcome: 'SUCCESS' | 'REFUSED' | 'NO_CHANGE',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorUserId,
      organizationId,
      action,
      entityType: 'OrganizerPayoutAccount',
      entityId,
      metadata: { outcome, ...metadata },
      correlationId: currentRequest()?.correlationId ?? null,
    });
  }

  /**
   * Tell every owner. Masked by construction: the payload is built here from the bank name, the
   * currency, the last four digits and the names of the fields that changed - never the number,
   * never the holder's name. Never throws (the audience service swallows and logs), because the
   * change is already durable and a mail outage must not undo it.
   */
  private async notifyOwners(
    organizationId: string,
    change: 'SAVED' | 'VERIFIED' | 'REJECTED',
    row: { currency: string; bankName: string; accountLast4: string; version: number },
    extra: { changedFields?: string[]; reason?: string } = {},
  ): Promise<void> {
    await this.audience.notifyOrganizationOwners(
      organizationId,
      NotificationType.PAYOUT_ACCOUNT_UPDATED,
      {
        change,
        currency: row.currency,
        bankName: row.bankName,
        accountLast4: row.accountLast4,
        version: row.version,
        ...(extra.changedFields ? { changedFields: extra.changedFields } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
      },
    );
  }

  /** The organizer's own accounts, masked. */
  async listForOrg(user: RequestUser, organizationId: string): Promise<PayoutAccountView[]> {
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    const rows = await this.prisma.organizerPayoutAccount.findMany({
      where: { organizationId },
      orderBy: { currency: 'asc' },
    });
    return rows.map((row) => this.view(row));
  }

  /**
   * Add or replace the account for one currency.
   *
   * ── EVERY CHANGE IS A NEW VERSION ──────────────────────────────────────────────────
   * The row holds the CURRENT details; each save also writes one history row (masked) in the
   * same transaction, so a change can never exist without its record. Saving clears any
   * verification or rejection: a new number has not been checked against anything, and carrying
   * the old tick over would say somebody had verified an account they never saw.
   *
   * Saving details identical to what is already on file changes nothing: no new version, no
   * email, and verification is kept. Re-saving the same account must not be a way to knock a
   * verified account back to pending, nor to spam the owners. (A REJECTED account saved again,
   * even unchanged, does start a new version: that is the owner asking for another check.)
   */
  async save(
    user: RequestUser,
    organizationId: string,
    input: {
      currency: string;
      holderName: string;
      bankName: string;
      bankCode: string;
      accountNumber: string;
    },
  ): Promise<PayoutAccountView> {
    await this.access.assertMember(user, organizationId, [Role.ORGANIZER_OWNER]);

    const accountNumber = input.accountNumber.replace(/[\s-]/g, '');
    if (!/^[0-9]{6,20}$/.test(accountNumber)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'An account number is 6 to 20 digits. Check it against your bank statement.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Pick the currency this account receives.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const key = this.key();
    let accountCipher: string;
    try {
      accountCipher = encryptAccountNumber(accountNumber, key);
    } catch (err) {
      /*
        No key configured. Refused rather than stored weaker: a deployment that has not set
        one simply cannot hold bank details, which is the right outcome. The organizer is told
        something is missing at our end, not that their details are wrong.
      */
      if (err instanceof BankSecretKeyMissing) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          'Bank details cannot be stored on this environment yet. Tell support; nothing you typed was saved.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw err;
    }

    const details = {
      holderName: input.holderName.trim(),
      bankName: input.bankName.trim(),
      bankCode: input.bankCode.trim().toUpperCase(),
      accountLast4: last4(accountNumber),
    };

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Serialise concurrent saves of one account, so two owners cannot both think they made
      // version 3. A first save has no row to lock; the unique key settles that race instead.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "OrganizerPayoutAccount"
                   WHERE "organizationId" = ${organizationId} AND "currency" = ${currency}
                   FOR UPDATE`,
      );
      const existing = await tx.organizerPayoutAccount.findUnique({
        where: { organizationId_currency: { organizationId, currency } },
      });

      let numberChanged = true;
      if (existing) {
        try {
          numberChanged = decryptAccountNumber(existing.accountCipher, key) !== accountNumber;
        } catch {
          // Cannot read the old number (rotated key): treat it as changed rather than guess.
          numberChanged = true;
        }
      }
      const changed = changedFieldsOf(existing, details, numberChanged);

      if (existing && changed !== 'initial' && changed.length === 0 && !existing.rejectedAt) {
        return { row: existing, changedFields: [] as string[], created: false };
      }
      const changedFields: string[] = changed === 'initial' ? ['initial'] : changed;

      const data = {
        ...details,
        accountCipher,
        verifiedAt: null,
        verifiedByUserId: null,
        rejectedAt: null,
        rejectedByUserId: null,
        rejectionReason: null,
        updatedByUserId: user.id,
      };
      const row = existing
        ? await tx.organizerPayoutAccount.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.organizerPayoutAccount.create({
            data: { organizationId, currency, version: 1, ...data },
          });

      // Details nobody got to decide on are superseded, not silently overwritten.
      await tx.organizerPayoutAccountVersion.updateMany({
        where: { accountId: row.id, status: 'PENDING_VERIFICATION' },
        data: { status: 'SUPERSEDED' },
      });
      await tx.organizerPayoutAccountVersion.create({
        data: {
          accountId: row.id,
          organizationId,
          currency,
          version: row.version,
          ...details,
          changedFields,
          savedByUserId: user.id,
        },
      });
      return { row, changedFields, created: true };
    });

    if (!outcome.created) {
      await this.record(
        user.id,
        organizationId,
        outcome.row.id,
        'PAYOUT_ACCOUNT_SAVED',
        'NO_CHANGE',
        { currency, accountLast4: details.accountLast4, version: outcome.row.version },
      );
      return this.view(outcome.row);
    }

    await this.record(user.id, organizationId, outcome.row.id, 'PAYOUT_ACCOUNT_SAVED', 'SUCCESS', {
      // The number is never in the log, only enough to tell one account from another.
      currency,
      bankCode: details.bankCode,
      accountLast4: details.accountLast4,
      version: outcome.row.version,
      changedFields: outcome.changedFields,
    });
    await this.notifyOwners(organizationId, 'SAVED', outcome.row, {
      changedFields: outcome.changedFields,
    });
    await this.notifyVerifiers(user, organizationId, outcome.row, outcome.changedFields);
    return this.view(outcome.row);
  }

  /**
   * Tell the staff who can verify it that an account is waiting.
   *
   * ── WHY ──────────────────────────────────────────────────────────────────────────────
   * A save used to tell the owners and nobody else, and the admin dashboard had no queue for it,
   * so a new bank account sat at "waiting for verification" with nobody aware it was there - and
   * no payout can be made to it until somebody checks it.
   *
   * ── WHO ──────────────────────────────────────────────────────────────────────────────
   * Staff who hold what the verify route needs (PAYOUT_MANAGE and BANK_VERIFY), less the people
   * maker-checker would refuse: whoever entered the details and every member of the organization.
   * The notice says so in words, because the person most likely to wonder why nobody has acted
   * is the one who may not.
   *
   * Masked like the owners' copy: bank, currency, last four digits and field names. Never throws
   * (the audience service swallows and logs); the save is already durable.
   */
  private async notifyVerifiers(
    user: RequestUser,
    organizationId: string,
    row: { id: string; currency: string; bankName: string; accountLast4: string; version: number },
    changedFields: string[],
  ): Promise<void> {
    try {
      const [org, members, saver] = await Promise.all([
        this.prisma.organization.findUnique({
          where: { id: organizationId },
          select: { name: true },
        }),
        this.prisma.organizationMember.findMany({
          where: { organizationId },
          select: { userId: true },
        }),
        this.prisma.user.findUnique({ where: { id: user.id }, select: { email: true } }),
      ]);
      const ruledOut = new Set([user.id, ...members.map((m) => m.userId)]);
      await this.audience.notifyAdminsHolding(
        [AdminPermission.PAYOUT_MANAGE, AdminPermission.BANK_VERIFY],
        NotificationType.PAYOUT_ACCOUNT_AWAITING_VERIFICATION,
        {
          accountId: row.id,
          organizationId,
          organizationName: org?.name ?? '',
          currency: row.currency,
          bankName: row.bankName,
          accountLast4: row.accountLast4,
          version: row.version,
          changedFields,
          savedByEmail: saver?.email ?? user.email ?? '',
        },
        { skip: (id) => ruledOut.has(id) },
      );
    } catch {
      // A lookup failing here must not fail a save that has already been committed.
    }
  }

  /**
   * Every account, masked, for the admin making transfers.
   *
   * `viewer` is the admin asking. For each account still waiting, `independenceBlock` says
   * whether maker-checker would refuse THIS person's decision, and why, using the same rule as
   * `assertIndependent`. The screen used to find out only after the click, so the one person who
   * could not verify (the owner who is also staff) was shown a button that could only fail. It
   * is advice for the screen; the decision routes still check for themselves.
   */
  async adminList(viewer?: Pick<RequestUser, 'id'>): Promise<
    (PayoutAccountView & {
      organization: { id: string; name: string };
      /** Who entered these details. Shown so a reviewer can see they are not that person. */
      savedBy: { id: string; email: string } | null;
      /** Who verified the current version. That person can never pay into this account. */
      verifiedBy: { id: string; email: string } | null;
      /** Why the viewer may not decide on this account; null when they may (or it is decided). */
      independenceBlock: 'SAME_PERSON' | 'ORGANIZATION_MEMBER' | null;
    })[]
  > {
    const [rows, memberships] = await Promise.all([
      this.prisma.organizerPayoutAccount.findMany({
        include: { organization: { select: { id: true, name: true } } },
        orderBy: [{ organizationId: 'asc' }, { currency: 'asc' }],
      }),
      viewer
        ? this.prisma.organizationMember.findMany({
            where: { userId: viewer.id },
            select: { organizationId: true },
          })
        : Promise.resolve([] as { organizationId: string }[]),
    ]);
    const memberOf = new Set(memberships.map((m) => m.organizationId));
    const people = await this.emails(rows.flatMap((r) => [r.updatedByUserId, r.verifiedByUserId]));
    return rows.map((row) => ({
      ...this.view(row),
      independenceBlock:
        viewer && reviewStatusOf(row) === 'PENDING_VERIFICATION'
          ? independenceFailure({
              actorUserId: viewer.id,
              savedByUserId: row.updatedByUserId,
              actorIsMember: memberOf.has(row.organizationId),
            })
          : null,
      organization: row.organization,
      savedBy: row.updatedByUserId
        ? { id: row.updatedByUserId, email: people.get(row.updatedByUserId) ?? '' }
        : null,
      verifiedBy:
        row.verifiedAt && row.verifiedByUserId
          ? { id: row.verifiedByUserId, email: people.get(row.verifiedByUserId) ?? '' }
          : null,
    }));
  }

  private async emails(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.email]));
  }

  private historyView(
    row: {
      version: number;
      currency: string;
      holderName: string;
      bankName: string;
      bankCode: string;
      accountLast4: string;
      changedFields: string[];
      status: PayoutAccountVersionView['status'];
      createdAt: Date;
      savedByUserId: string | null;
      decidedAt: Date | null;
      decisionNote: string | null;
    },
    people: Map<string, string>,
  ): PayoutAccountVersionView {
    return {
      version: row.version,
      currency: row.currency,
      holderName: row.holderName,
      bankName: row.bankName,
      bankCode: row.bankCode,
      accountLast4: row.accountLast4,
      changedFields: row.changedFields,
      status: row.status,
      savedAt: row.createdAt,
      savedBy: row.savedByUserId ? (people.get(row.savedByUserId) ?? null) : null,
      decidedAt: row.decidedAt,
      decisionNote: row.decisionNote,
    };
  }

  /**
   * The organization's own history, newest first. Masked, and it names who SAVED each version
   * (a member of their own team) but never which staff member decided: staff identity is not an
   * organizer's to see.
   */
  async historyForOrg(
    user: RequestUser,
    organizationId: string,
    currency?: string,
  ): Promise<PayoutAccountVersionView[]> {
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    const rows = await this.prisma.organizerPayoutAccountVersion.findMany({
      where: { organizationId, ...(currency ? { currency: currency.toUpperCase() } : {}) },
      orderBy: [{ currency: 'asc' }, { version: 'desc' }],
    });
    const people = await this.emails(rows.map((r) => r.savedByUserId));
    return rows.map((r) => this.historyView(r, people));
  }

  /** One account's history for staff, with who decided each version. */
  async adminHistory(
    id: string,
  ): Promise<(PayoutAccountVersionView & { decidedBy: string | null })[]> {
    const rows = await this.prisma.organizerPayoutAccountVersion.findMany({
      where: { accountId: id },
      orderBy: { version: 'desc' },
    });
    const people = await this.emails(rows.flatMap((r) => [r.savedByUserId, r.decidedByUserId]));
    return rows.map((r) => ({
      ...this.historyView(r, people),
      decidedBy: r.decidedByUserId ? (people.get(r.decidedByUserId) ?? null) : null,
    }));
  }

  /**
   * The full account number, once, for the person about to make the transfer.
   *
   * Recorded in the audit log with who asked and why. A reveal is not a read: it is somebody
   * taking a bank account number out of the system, and the log is what makes that answerable
   * later. The same shape as the SNS confirmation reveal, for the same reason.
   */
  async reveal(admin: RequestUser, id: string, reason: string) {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Say why you need the account number. The reveal is recorded with the reason.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (looksLikeAccountNumber(trimmedReason)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Do not type an account number in the reason. The reason is stored in the audit log.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const row = await this.prisma.organizerPayoutAccount.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'No account on file.', HttpStatus.NOT_FOUND);
    }

    let accountNumber: string;
    try {
      accountNumber = decryptAccountNumber(row.accountCipher, this.key());
    } catch (err) {
      /*
        Wrong key, or a row somebody has edited. Either way the honest answer is that we
        cannot read it, not a guess: an account number that decrypts to something else moves
        money to somebody else.
      */
      throw new AppException(
        ErrorCodes.INTERNAL,
        err instanceof BankSecretKeyMissing
          ? 'This environment has no key for stored bank details.'
          : 'These bank details cannot be read. Ask the organizer to enter them again.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    await this.record(admin.id, row.organizationId, row.id, 'PAYOUT_ACCOUNT_REVEALED', 'SUCCESS', {
      currency: row.currency,
      accountLast4: row.accountLast4,
      version: row.version,
      status: reviewStatusOf(row),
      reason: trimmedReason,
    });

    return {
      ...this.view(row),
      accountNumber,
    };
  }

  /**
   * Maker-checker. Whoever decides on an account must be staff who neither entered it nor belong
   * to the organization it pays. Refusals are audited too: an attempt to verify your own entry is
   * exactly what an investigation looks for.
   */
  private async assertIndependent(
    admin: RequestUser,
    row: { id: string; organizationId: string; currency: string; updatedByUserId: string | null },
    action: string,
  ): Promise<void> {
    const membership = await this.prisma.organizationMember.count({
      where: { organizationId: row.organizationId, userId: admin.id },
    });
    const failure = independenceFailure({
      actorUserId: admin.id,
      savedByUserId: row.updatedByUserId,
      actorIsMember: membership > 0,
    });
    if (!failure) return;
    await this.record(admin.id, row.organizationId, row.id, action, 'REFUSED', {
      currency: row.currency,
      reasonCode: failure,
    });
    throw new AppException(
      ErrorCodes.FORBIDDEN,
      failure === 'SAME_PERSON'
        ? 'You entered these bank details, so someone else must check them.'
        : 'You belong to this organization, so someone else must check its bank details.',
      HttpStatus.FORBIDDEN,
    );
  }

  private async loadForDecision(id: string, expectedVersion: number | undefined) {
    const row = await this.prisma.organizerPayoutAccount.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'No account on file.', HttpStatus.NOT_FOUND);
    }
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      // The details changed after this reviewer looked. Deciding on what they saw would decide
      // on the wrong account.
      throw new AppException(
        ErrorCodes.CONFLICT,
        'These bank details changed since you opened them. Reload and check them again.',
        HttpStatus.CONFLICT,
      );
    }
    if (row.verifiedAt || row.rejectedAt) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This account was already ${row.verifiedAt ? 'verified' : 'rejected'}. The owner must save new details to start another check.`,
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  /**
   * Somebody has checked the account against a document or a penny transfer.
   *
   * Only staff who did not enter the details and are not members of the organization may do
   * this, and only for the version they were looking at (`expectedVersion`).
   */
  async markVerified(admin: RequestUser, id: string, expectedVersion?: number) {
    const row = await this.loadForDecision(id, expectedVersion);
    await this.assertIndependent(admin, row, 'PAYOUT_ACCOUNT_VERIFIED');

    const saved = await this.prisma.$transaction(async (tx) => {
      // Conditional on the version and on still being undecided: a save or another decision
      // that landed first makes this match nothing instead of overwriting it.
      const claim = await tx.organizerPayoutAccount.updateMany({
        where: { id, version: row.version, verifiedAt: null, rejectedAt: null },
        data: { verifiedAt: new Date(), verifiedByUserId: admin.id },
      });
      if (claim.count !== 1) return null;
      await tx.organizerPayoutAccountVersion.updateMany({
        where: { accountId: id, version: row.version },
        data: { status: 'VERIFIED', decidedAt: new Date(), decidedByUserId: admin.id },
      });
      return tx.organizerPayoutAccount.findUniqueOrThrow({ where: { id } });
    });
    if (!saved) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'These bank details changed while you were checking them. Reload and try again.',
        HttpStatus.CONFLICT,
      );
    }
    await this.record(admin.id, row.organizationId, id, 'PAYOUT_ACCOUNT_VERIFIED', 'SUCCESS', {
      currency: row.currency,
      accountLast4: row.accountLast4,
      version: row.version,
    });
    await this.notifyOwners(row.organizationId, 'VERIFIED', saved);
    return this.view(saved);
  }

  /** Staff could not verify the details. The owner is told why and must save them again. */
  async reject(admin: RequestUser, id: string, reason: string, expectedVersion?: number) {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Say why the details were not accepted. The owner is told.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (looksLikeAccountNumber(trimmedReason)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Do not type an account number in the reason. It is stored and emailed.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const row = await this.loadForDecision(id, expectedVersion);
    await this.assertIndependent(admin, row, 'PAYOUT_ACCOUNT_REJECTED');

    const saved = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.organizerPayoutAccount.updateMany({
        where: { id, version: row.version, verifiedAt: null, rejectedAt: null },
        data: {
          rejectedAt: new Date(),
          rejectedByUserId: admin.id,
          rejectionReason: trimmedReason,
        },
      });
      if (claim.count !== 1) return null;
      await tx.organizerPayoutAccountVersion.updateMany({
        where: { accountId: id, version: row.version },
        data: {
          status: 'REJECTED',
          decidedAt: new Date(),
          decidedByUserId: admin.id,
          decisionNote: trimmedReason,
        },
      });
      return tx.organizerPayoutAccount.findUniqueOrThrow({ where: { id } });
    });
    if (!saved) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'These bank details changed while you were checking them. Reload and try again.',
        HttpStatus.CONFLICT,
      );
    }
    await this.record(admin.id, row.organizationId, id, 'PAYOUT_ACCOUNT_REJECTED', 'SUCCESS', {
      currency: row.currency,
      accountLast4: row.accountLast4,
      version: row.version,
      reason: trimmedReason,
    });
    await this.notifyOwners(row.organizationId, 'REJECTED', saved, { reason: trimmedReason });
    return this.view(saved);
  }
}
