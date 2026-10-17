/**
 * Small wording rules for the Business reports > Tax tab. Display only: every number is an API
 * field, these only say it.
 */

/** "1 invoice", "2 invoices": a count with the right noun. "On 1 invoices" read as a typo. */
export function countWords(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * Whether the range holds no tax document at all. The banner above the figures ends "Any tax
 * below is from documents issued while a rule was active", and with nothing below it that
 * sentence pointed at an empty page. Counts only what the API sent: a currency block from an
 * older API (no document counts) is not taken as "none".
 */
export function noTaxDocuments(
  byCurrency: readonly { invoices?: number | null; creditNotes?: number | null }[],
): boolean {
  return byCurrency.every((c) => c.invoices === 0 && c.creditNotes === 0);
}
