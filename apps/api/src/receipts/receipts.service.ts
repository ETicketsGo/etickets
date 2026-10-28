import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { refundTaxForTickets, ticketNetPrices } from '../refunds/refund-tax';
import { documentOperator, type DocumentOperator } from '@eticketsgo/shared-types';
import {
  buildReceiptDocument,
  negateTotals,
  resolveSaleKind,
  type ReceiptDocument,
  type ReceiptKindName,
  type ReceiptLine,
  type ReceiptSeller,
  type ReceiptTaxLine,
  type ReceiptTotals,
} from './receipt-document';

/** Visible series prefix per document kind. Each kind numbers independently. */
const SERIES_PREFIX: Record<ReceiptKindName, string> = {
  TAX_INVOICE: 'INV',
  RECEIPT: 'RCT',
  CREDIT_NOTE: 'CRN',
};

@Injectable()
export class ReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserve the next number in one organization's series.
   *
   * Must run inside the issuing transaction. The counter row is upserted with an atomic
   * increment, so two confirmations racing on the same organization serialise on that row
   * and cannot be handed the same number — and because the increment shares the caller's
   * transaction, a rolled-back confirmation rolls the number back with it. That is what
   * keeps the series gapless rather than merely unique.
   */
  private async nextNumber(
    tx: Prisma.TransactionClient,
    organizationId: string,
    kind: ReceiptKindName,
    at: Date,
  ): Promise<string> {
    const prefix = SERIES_PREFIX[kind];
    const year = at.getUTCFullYear();
    const scope = `${organizationId}:${prefix}:${year}`;
    const counter = await tx.receiptCounter.upsert({
      where: { scope },
      create: { scope, value: 1 },
      update: { value: { increment: 1 } },
    });
    return `${prefix}-${year}-${String(counter.value).padStart(6, '0')}`;
  }

  private sellerFrom(org: {
    name: string;
    legalName: string | null;
    taxRegistrationKind: string | null;
    taxRegistrationNumber: string | null;
    registeredAddressLine1: string | null;
    registeredAddressLine2: string | null;
    registeredCity: string | null;
    registeredRegion: string | null;
    registeredPostalCode: string | null;
    registeredCountry: string | null;
    financeContactName: string | null;
    financeContactEmail: string | null;
    financeContactPhone: string | null;
  }): ReceiptSeller {
    return {
      name: org.name,
      legalName: org.legalName,
      taxRegistrationKind: org.taxRegistrationKind,
      taxRegistrationNumber: org.taxRegistrationNumber,
      address: {
        line1: org.registeredAddressLine1,
        line2: org.registeredAddressLine2,
        city: org.registeredCity,
        region: org.registeredRegion,
        postalCode: org.registeredPostalCode,
        country: org.registeredCountry,
      },
      contactName: org.financeContactName,
      contactEmail: org.financeContactEmail,
      contactPhone: org.financeContactPhone,
    };
  }

  /**
   * Issue the sale document for a booking that has just been confirmed.
   *
   * Called from inside the confirm transaction so that "confirmed" and "has a receipt" are
   * the same atomic fact. The `saleForBookingId` unique column makes a duplicate impossible
   * at the database level even if a redelivered webhook somehow reached here twice.
   */
  async issueForBooking(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        taxLines: true,
        items: {
          include: {
            ticketType: { select: { name: true } },
            addOn: { select: { name: true } },
          },
        },
        event: {
          select: { title: true, venue: { select: { name: true, city: true, country: true } } },
        },
        eventSession: { select: { startsAt: true } },
      },
    });
    if (!booking) return;
    const organization = await tx.organization.findUnique({
      where: { id: booking.organizationId },
    });
    if (!organization) return;

    const seller = this.sellerFrom(organization);
    const kind = resolveSaleKind(seller);
    const issuedAt = new Date();
    const number = await this.nextNumber(tx, booking.organizationId, kind, issuedAt);

    const lines: ReceiptLine[] = booking.items.map((item) => ({
      description: item.ticketType?.name ?? item.addOn?.name ?? 'Item',
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      lineTotalMinor: item.lineTotalMinor,
    }));

    const totals: ReceiptTotals = {
      subtotalMinor: booking.subtotalMinor,
      discountMinor: booking.discountMinor,
      feeMinor: booking.customerFeeMinor,
      taxMinor: booking.taxMinor,
      totalMinor: booking.totalMinor,
    };

    const document = buildReceiptDocument({
      kind,
      number,
      issuedAt,
      currency: booking.currency,
      seller,
      buyer: { name: booking.buyerName, email: booking.buyerEmail },
      order: {
        bookingId: booking.id,
        reference: booking.reference,
        eventTitle: booking.event?.title ?? null,
        sessionStartsAt: booking.eventSession?.startsAt?.toISOString() ?? null,
        venue: booking.event?.venue
          ? [booking.event.venue.name, booking.event.venue.city].filter(Boolean).join(', ')
          : null,
      },
      lines,
      taxLines: booking.taxLines.map((t) => ({
        label: t.label,
        rateBasisPoints: t.rateBasisPoints,
        baseMinor: t.baseMinor,
        amountMinor: t.amountMinor,
        basis: (t.basis as ReceiptTaxLine['basis']) ?? null,
        inclusive: t.inclusive ?? null,
      })),
      totals,
      /*
        The platform's company for this sale: where it happened, then the currency the payment
        routing took it in. Frozen on the document; a later change to the registry does not
        reach a receipt already issued.
      */
      operator: documentOperator({
        transactionCountry: booking.event?.venue?.country ?? null,
        currency: booking.currency,
      }),
      /*
        Itemised only when the customer bears the whole fee, so the parts always foot to the
        line above them. See ReceiptFeeParts for why this is conditional.
      */
      feeParts:
        booking.customerFeeMinor === booking.bookingFeeMinor + booking.paymentFeeMinor
          ? {
              bookingFeeMinor: booking.bookingFeeMinor,
              paymentFeeMinor: booking.paymentFeeMinor,
            }
          : undefined,
    });

    await tx.receipt.create({
      data: {
        number,
        kind,
        organizationId: booking.organizationId,
        bookingId: booking.id,
        saleForBookingId: booking.id,
        issuedAt,
        currency: booking.currency,
        ...totals,
        documentJson: document as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Issue a credit note for a completed refund.
   *
   * A refund does not edit the original document — that document recorded a sale that
   * genuinely happened. It is reversed by a second document, which is how the pair remains
   * auditable: the sale, and the reversal, both visible.
   *
   * Amounts are negative (see `negateTotals`), and scaled to the refunded amount rather than
   * assumed to be the whole booking, so this stays correct when partial refunds arrive.
   */
  async issueCreditNote(tx: Prisma.TransactionClient, refundId: string): Promise<void> {
    const refund = await tx.refund.findUnique({
      where: { id: refundId },
      include: {
        booking: { include: { taxLines: true, items: true } },
        creditNote: { select: { id: true } },
      },
    });
    if (!refund || refund.creditNote) return;

    const booking = refund.booking;
    const organization = await tx.organization.findUnique({
      where: { id: booking.organizationId },
    });
    if (!organization) return;
    const sale = await tx.receipt.findUnique({ where: { saleForBookingId: booking.id } });
    const seller = this.sellerFrom(organization);
    const issuedAt = new Date();
    const number = await this.nextNumber(tx, booking.organizationId, 'CREDIT_NOTE', issuedAt);

    /*
      The split is taken from the refund row, not re-derived from the booking.

      `Refund.taxMinor` records exactly how much of the returned money was tax, decided when
      the refund was requested. Apportioning it back out of a total here would round a second
      time and could print a tax figure that does not match the one actually returned — on a
      document a tax authority may read.

      `feeMinor` is zero because platform fees are not refunded: the credit note states what
      moved, and no fee moved.
    */
    const taxMinor = refund.taxMinor ?? 0;

    /*
      Which of that tax was ADDED to the returned tickets and which was already inside them.

      A refund of an Indian ticket returns its GST inside the ₹499, not on top of it, so the
      credit note's subtotal is the ticket price and the GST is disclosed as included — the
      same per-line reading the sale receipt uses. Worked out from the tickets the refund
      names, with the rule the refund itself was priced by.

      A refund that names no tickets predates this and recorded its tax as added; it keeps
      the arithmetic it was issued with.
    */
    /*
      Every ticket on the booking is read, not only the refunded ones, because a ticket's price
      after the discount is dealt out across the whole booking (see `ticketNetPrices`). Pricing
      the refunded tickets at their pre-coupon price split the tax as if more money had gone
      back than did, on the same refund the refund service had priced correctly.
    */
    const bookingTickets = refund.ticketIds.length
      ? await tx.ticket.findMany({
          where: { bookingId: booking.id },
          select: { id: true, ticketTypeId: true },
        })
      : [];
    const { netByTicket, bookingTicketsMinor } = ticketNetPrices(
      booking.items,
      bookingTickets,
      booking,
    );
    const ticketsMinor = refund.ticketIds.reduce((s, id) => s + (netByTicket.get(id) ?? 0), 0);
    const perLine =
      ticketsMinor > 0
        ? refundTaxForTickets(
            booking.taxLines,
            netByTicket,
            refund.ticketIds,
            bookingTicketsMinor,
            {
              /*
              A cancellation returned the fees, and the tax on them with them (see the refund
              service); the refund row records that as `platformFeeRefundedMinor`. Without
              this the credit note listed the ticket tax lines only while its total tax
              included the fee tax, so its own lines did not add up to it.
            */
              includeFeeTax: (refund.platformFeeRefundedMinor ?? 0) > 0,
            },
          )
        : null;
    const addedTaxMinor = perLine ? perLine.addedMinor : taxMinor;

    const positive: ReceiptTotals = {
      subtotalMinor: refund.amountMinor - addedTaxMinor,
      discountMinor: 0,
      feeMinor: 0,
      taxMinor,
      totalMinor: refund.amountMinor,
    };
    const totals = negateTotals(positive);
    /** Share of each original tax line being reversed, for a refund that names no tickets. */
    const taxShare = booking.taxMinor > 0 ? taxMinor / booking.taxMinor : 0;

    const document = buildReceiptDocument({
      kind: 'CREDIT_NOTE',
      number,
      issuedAt,
      currency: booking.currency,
      seller,
      buyer: { name: booking.buyerName, email: booking.buyerEmail },
      order: {
        bookingId: booking.id,
        reference: booking.reference,
        eventTitle: null,
        sessionStartsAt: null,
        venue: null,
      },
      lines: [
        {
          description: `Refund of ${booking.reference ?? booking.id}`,
          quantity: 1,
          unitPriceMinor: -refund.amountMinor,
          lineTotalMinor: -refund.amountMinor,
        },
      ],
      taxLines: perLine
        ? perLine.lines.map((t) => ({
            label: t.label,
            rateBasisPoints: t.rateBasisPoints,
            baseMinor: -t.baseMinor,
            amountMinor: -t.amountMinor,
            basis: (t.basis as ReceiptTaxLine['basis']) ?? null,
            inclusive: t.inclusive,
          }))
        : booking.taxLines.map((t) => ({
            label: t.label,
            rateBasisPoints: t.rateBasisPoints,
            baseMinor: -Math.round(t.baseMinor * taxShare),
            amountMinor: -Math.round(t.amountMinor * taxShare),
            basis: (t.basis as ReceiptTaxLine['basis']) ?? null,
            inclusive: t.inclusive ?? null,
          })),
      totals,
      reverses: sale ? { number: sale.number, issuedAt: sale.issuedAt } : null,
      reason: refund.reason,
      operator: reversalOperator(sale?.documentJson, booking.currency),
    });

    await tx.receipt.create({
      data: {
        number,
        kind: 'CREDIT_NOTE',
        organizationId: booking.organizationId,
        bookingId: booking.id,
        refundId: refund.id,
        reversesId: sale?.id ?? null,
        issuedAt,
        currency: booking.currency,
        ...totals,
        documentJson: document as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Issue the credit note that reverses the whole sale of a cash booking cancelled with no
   * refund: a counter cash sale whose show was cancelled.
   *
   * ── WHY THIS IS NOT `issueCreditNote` ──────────────────────────────────────────────
   * That one is keyed to a `Refund`, and a cash return is deliberately not a Refund: no money
   * passed through a provider, so a Refund row would be an unreconcilable figure in the
   * refund, settlement and payout reports. Without a credit note, though, the sale receipt
   * (a tax invoice, in India) stood in the books for a sale that was undone. So this issues
   * the same document, in the same CRN series, keyed by `cancellationForBookingId` instead.
   *
   * ── WHAT IT SAYS ───────────────────────────────────────────────────────────────────
   * Exactly the opposite of the sale document as it was ISSUED, read from that document and
   * not from the live booking: every tax line negated with its basis, the fee negated, the
   * total negated. So the sale and its credit note sum to zero on every column a report
   * reads. As with a refund credit note, the subtotal is the ticket value after the discount
   * and the discount column is zero: the renderer reads a discount as a deduction, and a
   * negative deduction on a credit note would not foot.
   *
   * Idempotent: a second call for the same booking returns the credit note already issued,
   * and the unique column makes a concurrent second issue fail rather than duplicate. Must run
   * inside the cancelling transaction, so "cancelled" and "reversed" commit together.
   */
  async issueCancellationCreditNote(
    tx: Prisma.TransactionClient,
    bookingId: string,
    reason: string,
  ): Promise<{ id: string; number: string; reversesId: string; reversesNumber: string } | null> {
    const sale = await tx.receipt.findUnique({ where: { saleForBookingId: bookingId } });
    // No sale document means nothing was ever recorded as sold, so there is nothing to reverse.
    if (!sale) return null;
    const existing = await tx.receipt.findUnique({
      where: { cancellationForBookingId: bookingId },
      select: { id: true, number: true },
    });
    if (existing) {
      return { ...existing, reversesId: sale.id, reversesNumber: sale.number };
    }

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        organizationId: true,
        reference: true,
        buyerName: true,
        buyerEmail: true,
      },
    });
    if (!booking) return null;
    const organization = await tx.organization.findUnique({
      where: { id: booking.organizationId },
    });
    if (!organization) return null;

    const issuedAt = new Date();
    const number = await this.nextNumber(tx, booking.organizationId, 'CREDIT_NOTE', issuedAt);
    const saleDoc = sale.documentJson as unknown as ReceiptDocument | null;

    // The ticket value after the discount: what the subtotal of a credit note means.
    const netOfDiscount = sale.subtotalMinor - Math.abs(sale.discountMinor);
    const totals = negateTotals({
      subtotalMinor: netOfDiscount,
      discountMinor: 0,
      feeMinor: sale.feeMinor,
      taxMinor: sale.taxMinor,
      totalMinor: sale.totalMinor,
    });

    const document = buildReceiptDocument({
      kind: 'CREDIT_NOTE',
      number,
      issuedAt,
      currency: sale.currency,
      seller: this.sellerFrom(organization),
      buyer: { name: booking.buyerName, email: booking.buyerEmail },
      order: saleDoc?.order ?? {
        bookingId: booking.id,
        reference: booking.reference,
        eventTitle: null,
        sessionStartsAt: null,
        venue: null,
      },
      lines: [
        {
          description: `Cancellation of ${booking.reference ?? booking.id}`,
          quantity: 1,
          unitPriceMinor: -netOfDiscount,
          lineTotalMinor: -netOfDiscount,
        },
      ],
      taxLines: (saleDoc?.taxLines ?? []).map((t) => ({
        label: t.label,
        rateBasisPoints: t.rateBasisPoints,
        baseMinor: -t.baseMinor,
        amountMinor: -t.amountMinor,
        basis: t.basis ?? null,
        inclusive: t.inclusive ?? null,
      })),
      totals,
      feeParts: saleDoc?.feeParts
        ? {
            bookingFeeMinor: -saleDoc.feeParts.bookingFeeMinor,
            paymentFeeMinor: -saleDoc.feeParts.paymentFeeMinor,
          }
        : undefined,
      reverses: { number: sale.number, issuedAt: sale.issuedAt },
      operator: reversalOperator(sale.documentJson, sale.currency),
      reason,
    });

    const created = await tx.receipt.create({
      data: {
        number,
        kind: 'CREDIT_NOTE',
        organizationId: booking.organizationId,
        bookingId: booking.id,
        cancellationForBookingId: booking.id,
        reversesId: sale.id,
        issuedAt,
        currency: sale.currency,
        ...totals,
        documentJson: document as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, number: true },
    });
    return { ...created, reversesId: sale.id, reversesNumber: sale.number };
  }

  /** Every document issued for one booking, oldest first. */
  async listForBooking(bookingId: string) {
    return this.prisma.receipt.findMany({
      where: { bookingId },
      orderBy: { issuedAt: 'asc' },
      select: {
        id: true,
        number: true,
        kind: true,
        issuedAt: true,
        currency: true,
        totalMinor: true,
        taxMinor: true,
      },
    });
  }

  /**
   * One document, with the caller's right to see it already established by the controller.
   * Returns the frozen snapshot, never a recomputation.
   */
  async document(receiptId: string): Promise<{
    receipt: { organizationId: string; bookingId: string; number: string };
    document: ReceiptDocument;
  }> {
    const receipt = await this.prisma.receipt.findUnique({ where: { id: receiptId } });
    if (!receipt) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Document not found.', HttpStatus.NOT_FOUND);
    }
    return {
      receipt: {
        organizationId: receipt.organizationId,
        bookingId: receipt.bookingId,
        number: receipt.number,
      },
      document: receipt.documentJson as unknown as ReceiptDocument,
    };
  }

  /** An organization's issued documents, newest first — the organizer's books. */
  async listForOrganization(
    organizationId: string,
    opts: { page?: number; pageSize?: number; from?: Date; to?: Date } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
    const where: Prisma.ReceiptWhereInput = {
      organizationId,
      ...(opts.from || opts.to
        ? {
            issuedAt: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          number: true,
          kind: true,
          issuedAt: true,
          currency: true,
          subtotalMinor: true,
          feeMinor: true,
          taxMinor: true,
          totalMinor: true,
          booking: { select: { id: true, reference: true, buyerName: true } },
        },
      }),
      this.prisma.receipt.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * Every document issued to one buyer, across all their bookings.
   *
   * ── WHY THIS DID NOT EXIST ─────────────────────────────────────────────────────────
   * A receipt could be fetched for a BOOKING you already had the id of, or listed for an
   * ORGANIZATION you were a member of. There was nothing in between — so a customer who
   * closed the confirmation page without saving their receipt had no route back to it at
   * all, short of finding the booking again and knowing a receipts tab existed. Every
   * financial document the platform issues to a person was reachable only by remembering
   * where it came from.
   *
   * Scoped by `booking.userId`, so a guest checkout with no account is deliberately absent:
   * those documents are reached through the guest booking link, and matching an email
   * against a session is not an authorization.
   */
  async listForUser(userId: string, opts: { page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
    const where: Prisma.ReceiptWhereInput = { booking: { userId } };
    const [items, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          number: true,
          kind: true,
          issuedAt: true,
          currency: true,
          totalMinor: true,
          taxMinor: true,
          // What it was FOR. A list of numbers and amounts is not something a person can
          // find their concert in.
          booking: {
            select: {
              id: true,
              reference: true,
              event: { select: { title: true } },
              eventSession: { select: { startsAt: true } },
            },
          },
        },
      }),
      this.prisma.receipt.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
}

/**
 * The operator a reversal names: the one its sale document names, so the pair agree. A sale
 * issued before documents recorded an operator has none, and the credit note (a NEW
 * document) resolves its own from the currency. The sale document itself is never touched.
 */
function reversalOperator(saleDocument: unknown, currency: string): DocumentOperator {
  const stored = (saleDocument as { operator?: DocumentOperator } | null | undefined)?.operator;
  return stored?.legalName && stored.country ? stored : documentOperator({ currency });
}
