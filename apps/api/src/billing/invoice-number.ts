import type { Prisma } from '@prisma/client';

/**
 * Platform invoice numbers: `ETG-BIL-<YEAR>-<SEQ>`, e.g. `ETG-BIL-2026-000001`.
 *
 * The same mechanism as support references (support/support-reference.ts), on its own series:
 * - Series: one per UTC year of the ISSUE date (counter scope `BIL-<YEAR>`), restarting at
 *   000001. Never shared with `SUP-<YEAR>` or any other scope.
 * - Source: `etg_next_reference_value('BIL-<YEAR>')`, one upsert on ReadableReferenceCounter,
 *   called inside the transaction that issues the invoice. The row lock serialises concurrent
 *   issues and a rolled-back issue gives its number back, so the series has no gaps.
 * - Only an issued invoice has a number (a database CHECK ties DRAFT to "no number"), and a
 *   trigger stops a number from changing or an issued invoice from being deleted.
 *
 * Owner decision pending: an Indian GST invoice series normally runs per FINANCIAL year
 * (April-March). Changing the series boundary is a change to `invoiceSeriesYear` only.
 */
export const INVOICE_NUMBER_PREFIX = 'ETG-BIL';

export function invoiceSeriesYear(issuedAt: Date): number {
  return issuedAt.getUTCFullYear();
}

export function invoiceNumberScope(year: number): string {
  return `BIL-${year}`;
}

export function formatInvoiceNumber(year: number, seq: number): string {
  return `${INVOICE_NUMBER_PREFIX}-${year}-${String(seq).padStart(6, '0')}`;
}

/** Takes the next number. Must run inside the transaction that issues the invoice. */
export async function assignInvoiceNumber(
  tx: Prisma.TransactionClient,
  issuedAt: Date,
): Promise<string> {
  const year = invoiceSeriesYear(issuedAt);
  const rows = await tx.$queryRaw<{ value: number }[]>`
    SELECT "etg_next_reference_value"(${invoiceNumberScope(year)}) AS value`;
  const value = Number(rows[0]?.value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invoice number counter returned no value for ${year}`);
  }
  return formatInvoiceNumber(year, value);
}
