import type { Prisma } from '@prisma/client';

/**
 * Platform invoice numbers, one gapless series per country and period (owner decision
 * 2026-10-27).
 *
 *   India   ETGB-2627-000001        one series per Indian FINANCIAL year: 1 April to 31 March,
 *                                    decided in IST (UTC+05:30, no daylight saving). "2627" is
 *                                    FY 2026-27. Counter scope `BIL-IN-FY2026-27`.
 *   Others  ETG-BIL-US-2026-000001  one series per CALENDAR year (UTC) and country.
 *                                    Counter scope `BIL-US-2026`.
 *
 * ── WHY THE INDIAN NUMBER IS SHORTER ────────────────────────────────────────────────
 * A GST tax invoice number must be unique within the financial year and at most 16 characters,
 * using letters, digits, "-" and "/" (CGST Rules, rule 46(b)). `ETG-BIL-IN-FY2026-27-000001` is
 * 27 characters and would not be a valid GST invoice number; `ETGB-2627-000001` is exactly 16
 * and still says who issued it (ETicketsGo Billing) and which financial year it belongs to.
 * The 16-character limit holds up to 999,999 invoices in one financial year.
 *
 * ── HOW IT STAYS GAPLESS ───────────────────────────────────────────────────────────
 * `etg_next_reference_value(scope)` is one upsert on ReadableReferenceCounter, called inside the
 * transaction that issues the invoice. The row lock serialises concurrent issues and a
 * rolled-back issue gives its number back. Only an issued invoice has a number (a database
 * CHECK ties DRAFT to "no number" and holds the two shapes above), and a trigger stops a number
 * from changing or an issued invoice from being deleted.
 */
export const INVOICE_NUMBER_PREFIX = 'ETG-BIL';
export const INDIA_INVOICE_PREFIX = 'ETGB';

/** IST is a fixed UTC+05:30: India has no daylight saving. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export interface InvoiceSeries {
  /** The ReadableReferenceCounter scope. */
  scope: string;
  /** Formats a sequence number in this series. */
  format(seq: number): string;
}

/** The Indian financial year a moment falls in, by its start year: 2026 means FY 2026-27. */
export function indianFinancialYearStart(at: Date): number {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  // April is month 3 (zero-based). January to March belong to the year that began last April.
  return ist.getUTCMonth() >= 3 ? year : year - 1;
}

export function invoiceSeries(country: string, issuedAt: Date): InvoiceSeries {
  const cc = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : 'XX';
  if (cc === 'IN') {
    const start = indianFinancialYearStart(issuedAt);
    const endShort = String((start + 1) % 100).padStart(2, '0');
    const startShort = String(start % 100).padStart(2, '0');
    return {
      scope: `BIL-IN-FY${start}-${endShort}`,
      format: (seq) => `${INDIA_INVOICE_PREFIX}-${startShort}${endShort}-${pad(seq)}`,
    };
  }
  const year = issuedAt.getUTCFullYear();
  return {
    scope: `BIL-${cc}-${year}`,
    format: (seq) => `${INVOICE_NUMBER_PREFIX}-${cc}-${year}-${pad(seq)}`,
  };
}

function pad(seq: number): string {
  return String(seq).padStart(6, '0');
}

/** Takes the next number. Must run inside the transaction that issues the invoice. */
export async function assignInvoiceNumber(
  tx: Prisma.TransactionClient,
  issuedAt: Date,
  country: string,
): Promise<string> {
  const series = invoiceSeries(country, issuedAt);
  const rows = await tx.$queryRaw<{ value: number }[]>`
    SELECT "etg_next_reference_value"(${series.scope}) AS value`;
  const value = Number(rows[0]?.value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invoice number counter returned no value for ${series.scope}`);
  }
  return series.format(value);
}
