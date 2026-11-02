import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { assignInvoiceNumber } from './invoice-number';
import { documentOperator } from '@eticketsgo/shared-types';
import type { BillingTaxLine, BillingTaxQuote } from './billing-tax.service';
import { GST_NOT_CHARGED_NOTE, assertIndiaSellerReady, indiaSellerDetails } from './billing-seller';

/**
 * Printed only on an invoice that carries no tax line at all (the test double's payments).
 * A real provider payment is taxed by the configured rules or by Stripe Tax and lists its
 * lines, a 0% line included. Plain ASCII, per house rule.
 */
export const TAX_NOT_APPLIED_NOTE =
  'Tax not applied. ETicketsGo has not yet started charging tax on plan payments.';

/** The GST status frozen on a seller snapshot; null for a non-Indian seller. */
function sellerGstStatusOf(seller: object): 'REGISTERED' | 'UNREGISTERED' | null {
  const v = (seller as { gstStatus?: unknown }).gstStatus;
  return v === 'REGISTERED' || v === 'UNREGISTERED' ? v : null;
}

/** An unregistered supplier may not charge GST: such an invoice is refused, never issued. */
function assertNoGstFromUnregistered(seller: object, taxMinor: number): void {
  if (sellerGstStatusOf(seller) === 'UNREGISTERED' && taxMinor > 0) {
    throw new Error('An invoice from a seller not registered under GST cannot carry tax.');
  }
}

/** What the invoice says about tax: its lines and where it was supplied. */
export interface InvoiceTax {
  lines: BillingTaxLine[];
  mode: BillingTaxQuote['mode'] | 'NONE';
  jurisdiction: BillingTaxQuote['jurisdiction'] | null;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitAmountMinor: number;
}

/**
 * Platform invoices to organizers. NOT ticket receipts: a Receipt needs a booking and is
 * numbered per organizer; these are the platform's own documents, numbered per country series
 * (invoice-number.ts: ETGB-2627-000001 in India's financial year, ETG-BIL-US-2026-000001).
 *
 * Nothing creates one yet in production: invoices start with paid plans (the provider change).
 * The lifecycle is here so numbering and totals are settled - and tested - before then.
 */
@Injectable()
export class BillingInvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private get(name: string): string | undefined {
    return this.config?.get<string>(name);
  }

  /**
   * The issuing company, frozen on the document: the same country the number series follows.
   * An Indian invoice (ETGB) also carries the GST registration facts - GSTIN, SAC, registered
   * address and state - from configuration at the moment of issue (billing-seller.ts), with the
   * seller's GST status (`gstStatus`). An UNREGISTERED seller's snapshot has no GSTIN and no
   * SAC. In PRODUCTION an Indian invoice is refused while the status is UNVERIFIED or the facts
   * it needs are incomplete, invalid or contradictory.
   */
  private sellerSnapshot(country: string, currency: string) {
    const operator = documentOperator({ transactionCountry: country, currency });
    if (country !== 'IN') return operator;
    assertIndiaSellerReady((n) => this.get(n), country);
    const d = indiaSellerDetails((n) => this.get(n));
    return {
      ...operator,
      // Without configuration (a bare harness) nothing is known: no status is recorded rather
      // than one guessed, and the invoice prints as it did before the status existed.
      gstStatus: this.config ? d.gstStatus : null,
      gstin: d.gstin,
      sac: d.sac,
      address: d.address,
      state: d.state,
      stateCode: d.stateCode,
    };
  }

  /** Who is billed, frozen with the number: name, state (place of supply) and GSTIN if any. */
  private async buyerSnapshot(
    tx: Prisma.TransactionClient,
    account: { organizationId: string; country: string; taxId: string | null },
  ) {
    const org = await tx.organization.findUnique({
      where: { id: account.organizationId },
      select: { name: true, legalName: true, registeredRegion: true },
    });
    return {
      name: org?.legalName || org?.name || null,
      country: account.country,
      state: org?.registeredRegion?.trim() || null,
      taxId: account.taxId,
    };
  }

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
      const seller = this.sellerSnapshot(invoice.account.country, invoice.currency);
      assertNoGstFromUnregistered(seller, invoice.taxMinor);
      const buyer = await this.buyerSnapshot(tx, invoice.account);
      const number = await assignInvoiceNumber(tx, at, invoice.account.country);
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
            // The issuing company, frozen: the same country the number series follows.
            seller,
            sellerGstStatus: sellerGstStatusOf(seller),
            buyer,
            taxId: invoice.account.taxId,
            currency: invoice.currency,
            lines: invoice.lines,
            subtotalMinor: invoice.subtotalMinor,
            taxMinor: invoice.taxMinor,
            totalMinor: invoice.totalMinor,
          } as unknown as Prisma.InputJsonValue,
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
   * `taxMinor` is the tax actually charged and `tax.lines` itemise it (CGST + SGST or IGST, a
   * US state rate, or what Stripe Tax computed). The lines must add up to `taxMinor`, or the
   * invoice is refused: a document whose tax lines disagree with its total is not an invoice.
   */
  async recordPaidInTx(
    tx: Prisma.TransactionClient,
    input: {
      accountId: string;
      provider: 'MOCK' | 'STRIPE_BILLING' | 'RAZORPAY_BILLING';
      providerInvoiceRef: string;
      /** The provider's payment id, printed as the payment reference. */
      paymentRef?: string | null;
      currency: string;
      lines: InvoiceLine[];
      taxMinor: number;
      tax?: InvoiceTax;
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
    const taxLines = input.tax?.lines ?? [];
    if (taxLines.length > 0 && taxLines.reduce((s, l) => s + l.amountMinor, 0) !== taxMinor) {
      throw new Error('Invoice tax lines do not add up to the tax charged.');
    }
    // Before the number is taken: a refused seller leaves the series untouched.
    const seller = this.sellerSnapshot(account.country, input.currency);
    assertNoGstFromUnregistered(seller, taxMinor);
    const sellerGstStatus = sellerGstStatusOf(seller);
    const buyer = await this.buyerSnapshot(tx, account);
    const number = await assignInvoiceNumber(tx, input.paidAt, account.country);
    const taxNote =
      sellerGstStatus === 'UNREGISTERED'
        ? GST_NOT_CHARGED_NOTE
        : taxMinor > 0 || taxLines.length > 0
          ? null
          : TAX_NOT_APPLIED_NOTE;
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
          /*
            The issuing company, frozen with the number. Resolved from the account country -
            the same country the series follows, so an ETGB number is always issued by the
            Indian company - then the currency. A document issued before this field existed
            has none and keeps printing what it printed.
          */
          seller,
          // The seller's GST status when issued: REGISTERED (tax invoice), UNREGISTERED
          // (ordinary invoice, no GST) or null (not India, or issued before this was recorded).
          sellerGstStatus,
          buyer,
          taxId: account.taxId,
          currency: input.currency,
          lines: input.lines,
          subtotalMinor,
          taxMinor,
          totalMinor: subtotalMinor + taxMinor,
          taxLines,
          taxMode: input.tax?.mode ?? 'NONE',
          placeOfSupply: input.tax?.jurisdiction ?? null,
          taxNote,
          provider: input.provider,
          providerInvoiceRef: input.providerInvoiceRef,
          paymentRef: input.paymentRef ?? null,
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
