import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { assignInvoiceNumber } from './invoice-number';

/** Printed on a plan invoice when the provider computed no tax. Plain ASCII, per house rule. */
export const TAX_NOT_APPLIED_NOTE =
  'Tax not applied. ETicketsGo has not yet started charging tax on plan payments.';

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitAmountMinor: number;
}

/**
 * Platform invoices to organizers. NOT ticket receipts: a Receipt needs a booking and is
 * numbered per organizer; these are the platform's own documents, numbered ETG-BIL-<YEAR>-<SEQ>.
 *
 * Nothing creates one yet in production: invoices start with paid plans (the provider change).
 * The lifecycle is here so numbering and totals are settled - and tested - before then.
 */
@Injectable()
export class BillingInvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  async createDraft(
    accountId: string,
    input: {
      currency: string;
      lines: InvoiceLine[];
      taxMinor?: number;
      subscriptionId?: string | null;
      periodStart?: Date | null;
      periodEnd?: Date | null;
    },
  ) {
    if (input.lines.length === 0) {
      throw new AppException(ErrorCodes.VALIDATION_FAILED, 'An invoice needs at least one line.');
    }
    for (const l of input.lines) {
      if (
        !Number.isInteger(l.quantity) ||
        l.quantity <= 0 ||
        !Number.isInteger(l.unitAmountMinor) ||
        l.unitAmountMinor < 0
      ) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          'Each line needs a whole quantity and amount.',
        );
      }
    }
    const subtotalMinor = input.lines.reduce((s, l) => s + l.quantity * l.unitAmountMinor, 0);
    const taxMinor = input.taxMinor ?? 0;
    return this.prisma.organizerInvoice.create({
      data: {
        accountId,
        subscriptionId: input.subscriptionId ?? null,
        status: 'DRAFT',
        currency: input.currency,
        lines: input.lines as unknown as Prisma.InputJsonValue,
        subtotalMinor,
        taxMinor,
        totalMinor: subtotalMinor + taxMinor,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
      },
    });
  }

  /**
   * DRAFT -> OPEN with the next number in the issue year's series. The number is taken in the
   * same transaction as the status change, after the row is locked: two issues of one draft
   * cannot both number it, and a failure gives the number back.
   */
  async issue(invoiceId: string, at: Date = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS status FROM "OrganizerInvoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
      if (locked.length === 0) {
        throw new AppException(ErrorCodes.NOT_FOUND, 'Invoice not found.', HttpStatus.NOT_FOUND);
      }
      if (locked[0].status !== 'DRAFT') {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'Only a draft invoice can be issued.',
          HttpStatus.CONFLICT,
        );
      }
      const invoice = await tx.organizerInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { account: true },
      });
      const number = await assignInvoiceNumber(tx, at);
      return tx.organizerInvoice.update({
        where: { id: invoiceId },
        data: {
          status: 'OPEN',
          number,
          issuedAt: at,
          documentJson: {
            number,
            issuedAt: at.toISOString(),
            organizationId: invoice.account.organizationId,
            billingCountry: invoice.account.country,
            taxId: invoice.account.taxId,
            currency: invoice.currency,
            lines: invoice.lines,
            subtotalMinor: invoice.subtotalMinor,
            taxMinor: invoice.taxMinor,
            totalMinor: invoice.totalMinor,
          } as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * A PAID invoice for a payment the provider verified, numbered in the ETG-BIL series, inside
   * the caller's transaction (which holds the billing account lock). Idempotent per provider
   * document: if one already records `providerInvoiceRef`, that one is returned and no number is
   * taken. A rollback of the caller gives the number back, so the series stays gapless.
   *
   * Tax is what the PROVIDER computed. When it computed none, taxMinor is 0 and the document
   * says plainly that tax was not applied (owner decision pending on tax for plan invoices).
   */
  async recordPaidInTx(
    tx: Prisma.TransactionClient,
    input: {
      accountId: string;
      provider: 'MOCK' | 'STRIPE_BILLING' | 'RAZORPAY_BILLING';
      providerInvoiceRef: string;
      currency: string;
      lines: InvoiceLine[];
      taxMinor: number;
      subscriptionId?: string | null;
      periodStart?: Date | null;
      periodEnd?: Date | null;
      paidAt: Date;
    },
  ) {
    const existing = await tx.organizerInvoice.findUnique({
      where: {
        provider_providerInvoiceRef: {
          provider: input.provider,
          providerInvoiceRef: input.providerInvoiceRef,
        },
      },
    });
    if (existing) return { invoice: existing, created: false };
    const account = await tx.organizerBillingAccount.findUniqueOrThrow({
      where: { id: input.accountId },
    });
    const subtotalMinor = input.lines.reduce((s, l) => s + l.quantity * l.unitAmountMinor, 0);
    const taxMinor = Math.max(0, Math.trunc(input.taxMinor));
    const number = await assignInvoiceNumber(tx, input.paidAt);
    const taxNote = taxMinor > 0 ? null : TAX_NOT_APPLIED_NOTE;
    const invoice = await tx.organizerInvoice.create({
      data: {
        accountId: input.accountId,
        subscriptionId: input.subscriptionId ?? null,
        status: 'PAID',
        number,
        issuedAt: input.paidAt,
        currency: input.currency,
        lines: input.lines as unknown as Prisma.InputJsonValue,
        subtotalMinor,
        taxMinor,
        totalMinor: subtotalMinor + taxMinor,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        provider: input.provider,
        providerInvoiceRef: input.providerInvoiceRef,
        documentJson: {
          number,
          issuedAt: input.paidAt.toISOString(),
          paidAt: input.paidAt.toISOString(),
          organizationId: account.organizationId,
          billingCountry: account.country,
          taxId: account.taxId,
          currency: input.currency,
          lines: input.lines,
          subtotalMinor,
          taxMinor,
          totalMinor: subtotalMinor + taxMinor,
          taxNote,
          provider: input.provider,
          providerInvoiceRef: input.providerInvoiceRef,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return { invoice, created: true };
  }

  listForAccount(accountId: string) {
    return this.prisma.organizerInvoice.findMany({
      where: { accountId, status: { not: 'DRAFT' } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        number: true,
        status: true,
        currency: true,
        subtotalMinor: true,
        taxMinor: true,
        totalMinor: true,
        issuedAt: true,
        periodStart: true,
        periodEnd: true,
      },
    });
  }
}
