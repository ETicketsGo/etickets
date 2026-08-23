import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import {
  buildReceiptDocument,
  negateTotals,
  resolveSaleKind,
  type ReceiptDocument,
  type ReceiptKindName,
  type ReceiptLine,
  type ReceiptSeller,
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
        event: { select: { title: true, venue: { select: { name: true, city: true } } } },
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
      })),
      totals,
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
        booking: { include: { taxLines: true } },
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
    const positive: ReceiptTotals = {
      subtotalMinor: refund.amountMinor - taxMinor,
      discountMinor: 0,
      feeMinor: 0,
      taxMinor,
      totalMinor: refund.amountMinor,
    };
    const totals = negateTotals(positive);
    /** Share of each original tax line being reversed, for the itemised breakdown. */
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
      taxLines: booking.taxLines.map((t) => ({
        label: t.label,
        rateBasisPoints: t.rateBasisPoints,
        baseMinor: -Math.round(t.baseMinor * taxShare),
        amountMinor: -Math.round(t.amountMinor * taxShare),
      })),
      totals,
      reverses: sale ? { number: sale.number, issuedAt: sale.issuedAt } : null,
      reason: refund.reason,
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
}
