import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import {
  BankSecretKeyMissing,
  bankKey,
  decryptAccountNumber,
  encryptAccountNumber,
  last4,
} from './bank-secret';

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
}

@Injectable()
export class PayoutAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
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
    };
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
   * Replacing clears any verification: a new number has not been checked against anything,
   * and carrying the old tick over would say somebody had verified an account they never saw.
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

    let accountCipher: string;
    try {
      accountCipher = encryptAccountNumber(accountNumber, this.key());
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

    const data = {
      holderName: input.holderName.trim(),
      bankName: input.bankName.trim(),
      bankCode: input.bankCode.trim().toUpperCase(),
      accountLast4: last4(accountNumber),
      accountCipher,
      verifiedAt: null,
      verifiedByUserId: null,
      updatedByUserId: user.id,
    };

    const saved = await this.prisma.organizerPayoutAccount.upsert({
      where: { organizationId_currency: { organizationId, currency } },
      create: { organizationId, currency, ...data },
      update: data,
    });

    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'PAYOUT_ACCOUNT_SAVED',
      entityType: 'OrganizerPayoutAccount',
      entityId: saved.id,
      // The number is never in the log, only enough to tell one account from another.
      metadata: { currency, bankCode: data.bankCode, accountLast4: data.accountLast4 },
    });
    return this.view(saved);
  }

  /** Every account, masked, for the admin making transfers. */
  async adminList(): Promise<
    (PayoutAccountView & { organization: { id: string; name: string } })[]
  > {
    const rows = await this.prisma.organizerPayoutAccount.findMany({
      include: { organization: { select: { id: true, name: true } } },
      orderBy: [{ organizationId: 'asc' }, { currency: 'asc' }],
    });
    return rows.map((row) => ({ ...this.view(row), organization: row.organization }));
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

    await this.audit.record({
      actorUserId: admin.id,
      organizationId: row.organizationId,
      action: 'PAYOUT_ACCOUNT_REVEALED',
      entityType: 'OrganizerPayoutAccount',
      entityId: row.id,
      metadata: { currency: row.currency, accountLast4: row.accountLast4, reason: trimmedReason },
    });

    return {
      ...this.view(row),
      accountNumber,
    };
  }

  /** Somebody has checked the account against a document or a penny transfer. */
  async markVerified(admin: RequestUser, id: string) {
    const row = await this.prisma.organizerPayoutAccount.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'No account on file.', HttpStatus.NOT_FOUND);
    }
    const saved = await this.prisma.organizerPayoutAccount.update({
      where: { id },
      data: { verifiedAt: new Date(), verifiedByUserId: admin.id },
    });
    await this.audit.record({
      actorUserId: admin.id,
      organizationId: row.organizationId,
      action: 'PAYOUT_ACCOUNT_VERIFIED',
      entityType: 'OrganizerPayoutAccount',
      entityId: id,
      metadata: { currency: row.currency, accountLast4: row.accountLast4 },
    });
    return this.view(saved);
  }
}
