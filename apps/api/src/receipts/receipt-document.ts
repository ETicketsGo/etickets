/**
 * The shape of an issued financial document, and the pure function that builds one.
 *
 * Separated from the service so the document can be unit-tested without a database, and so
 * the exact bytes that get frozen into `Receipt.documentJson` are produced by one function
 * with no I/O in it.
 */

export const RECEIPT_DOCUMENT_VERSION = 1;

export type ReceiptKindName = 'RECEIPT' | 'TAX_INVOICE' | 'CREDIT_NOTE';

export interface ReceiptSeller {
  /** Trading name. */
  name: string;
  /** Registered legal name, when the organizer has recorded one. */
  legalName: string | null;
  /** What kind of registration the number is — "GSTIN", "EIN", "GST/HST", … */
  taxRegistrationKind: string | null;
  taxRegistrationNumber: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  };
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface ReceiptBuyer {
  name: string | null;
  email: string | null;
}

export interface ReceiptLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface ReceiptTaxLine {
  label: string;
  rateBasisPoints: number;
  baseMinor: number;
  amountMinor: number;
}

export interface ReceiptTotals {
  subtotalMinor: number;
  discountMinor: number;
  /** The fee the customer bears. Fees the organizer absorbs are not the buyer's business. */
  feeMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface ReceiptDocument {
  version: number;
  kind: ReceiptKindName;
  number: string;
  issuedAt: string;
  currency: string;
  seller: ReceiptSeller;
  buyer: ReceiptBuyer;
  order: {
    bookingId: string;
    reference: string | null;
    eventTitle: string | null;
    sessionStartsAt: string | null;
    venue: string | null;
  };
  lines: ReceiptLine[];
  taxLines: ReceiptTaxLine[];
  totals: ReceiptTotals;
  /** Statements that must appear on the face of the document. */
  notes: string[];
  /** Set on a credit note: the number of the sale document it reverses. */
  reverses?: { number: string; issuedAt: string } | null;
  reason?: string | null;
}

export interface BuildReceiptInput {
  kind: ReceiptKindName;
  number: string;
  issuedAt: Date;
  currency: string;
  seller: ReceiptSeller;
  buyer: ReceiptBuyer;
  order: ReceiptDocument['order'];
  lines: ReceiptLine[];
  taxLines: ReceiptTaxLine[];
  totals: ReceiptTotals;
  reverses?: { number: string; issuedAt: Date } | null;
  reason?: string | null;
}

/**
 * Decide what this document can honestly be called.
 *
 * A tax invoice is a specific instrument: it names a registered seller and states the tax
 * they collected. Issuing one for a seller with no registration on file would produce a
 * document that asserts something untrue, so the platform issues a plain receipt instead and
 * upgrades automatically the moment the organizer records their registration.
 *
 * This decides the document's NAME, never its arithmetic. What tax is charged is decided by
 * TaxRule configuration and nothing else.
 */
export function resolveSaleKind(
  seller: Pick<ReceiptSeller, 'taxRegistrationNumber'>,
): ReceiptKindName {
  return seller.taxRegistrationNumber?.trim() ? 'TAX_INVOICE' : 'RECEIPT';
}

/**
 * Statements that belong on the face of the document.
 *
 * The no-tax note exists so the absence of tax is EXPLICIT. A receipt that simply omits a tax
 * row is ambiguous — it could mean zero-rated, exempt, or a misconfiguration — and a buyer
 * or an auditor cannot tell which. Saying "no tax was charged" makes the platform's actual
 * behaviour legible instead of leaving it to be inferred.
 */
function buildNotes(input: BuildReceiptInput): string[] {
  const notes: string[] = [];
  if (input.taxLines.length === 0) {
    notes.push('No tax was charged on this sale.');
  }
  if (input.kind !== 'CREDIT_NOTE' && !input.seller.taxRegistrationNumber?.trim()) {
    notes.push('The seller has not recorded a tax registration, so this is not a tax invoice.');
  }
  if (input.kind === 'CREDIT_NOTE') {
    notes.push('This credit note reverses the document referenced above.');
  }
  return notes;
}

/** Build the immutable document. Pure: same inputs, same bytes, forever. */
export function buildReceiptDocument(input: BuildReceiptInput): ReceiptDocument {
  return {
    version: RECEIPT_DOCUMENT_VERSION,
    kind: input.kind,
    number: input.number,
    issuedAt: input.issuedAt.toISOString(),
    currency: input.currency,
    seller: input.seller,
    buyer: input.buyer,
    order: input.order,
    lines: input.lines,
    taxLines: input.taxLines,
    totals: input.totals,
    notes: buildNotes(input),
    reverses: input.reverses
      ? { number: input.reverses.number, issuedAt: input.reverses.issuedAt.toISOString() }
      : null,
    reason: input.reason ?? null,
  };
}

/**
 * Negate every money field, for a credit note.
 *
 * Credit notes store negative amounts so that summing a period's documents yields net
 * revenue with no special-casing — the alternative, positive amounts plus a sign convention
 * held in the reader's head, is where reconciliation bugs come from.
 */
export function negateTotals(t: ReceiptTotals): ReceiptTotals {
  return {
    subtotalMinor: -t.subtotalMinor,
    discountMinor: -t.discountMinor,
    feeMinor: -t.feeMinor,
    taxMinor: -t.taxMinor,
    totalMinor: -t.totalMinor,
  };
}
