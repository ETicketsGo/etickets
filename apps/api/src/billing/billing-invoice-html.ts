import { formatMinor } from '../receipts/receipt-html';
import { TAX_NOT_APPLIED_NOTE } from './billing-invoice.service';

/**
 * A platform invoice to an organizer (ETGB-2627-000001, ETG-BIL-US-2026-000001) as a
 * standalone, printable page.
 *
 * The same rules as the ticket receipt (receipts/receipt-html.ts), whose look it shares: a plain
 * string template, no scripts, no fonts or images to fetch, so it prints and saves as PDF from
 * any browser. It is NOT a ticket receipt: it is the platform's own document, in its own series.
 */
export interface BillingInvoiceView {
  number: string;
  status: string;
  issuedAt: Date;
  currency: string;
  lines: { description: string; quantity: number; unitAmountMinor: number }[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Each tax charged (CGST + SGST, IGST, a state rate, Stripe Tax). Empty: none recorded. */
  taxLines?: { label: string; rateBasisPoints: number; amountMinor: number }[];
  /** The organizer's state, which is the place of supply for the platform's service. */
  placeOfSupply?: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  sellerName: string;
  billedTo: { name: string; country: string; taxId: string | null; email: string | null };
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function renderBillingInvoiceHtml(v: BillingInvoiceView): string {
  const money = (minor: number) => esc(formatMinor(minor, v.currency));
  const rows = v.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.quantity)}</td>` +
        `<td class="num">${money(l.unitAmountMinor)}</td>` +
        `<td class="num">${money(l.quantity * l.unitAmountMinor)}</td></tr>`,
    )
    .join('\n');
  const period =
    v.periodStart && v.periodEnd
      ? `<div class="muted">Period ${esc(day(v.periodStart))} to ${esc(day(v.periodEnd))}</div>`
      : '';
  const taxLines = v.taxLines ?? [];
  const taxNote =
    v.taxMinor > 0 || taxLines.length > 0 ? '' : `<li>${esc(TAX_NOT_APPLIED_NOTE)}</li>`;
  const rate = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
  const taxRows =
    taxLines.length > 0
      ? taxLines
          .map(
            (l) =>
              `<tr><th colspan="3">${esc(l.label)}${l.rateBasisPoints > 0 ? ` (${esc(rate(l.rateBasisPoints))})` : ''}</th>` +
              `<td class="num">${money(l.amountMinor)}</td></tr>`,
          )
          .join('\n      ')
      : `<tr><th colspan="3">Tax</th><td class="num">${money(v.taxMinor)}</td></tr>`;
  const supply = v.placeOfSupply ? `<li>Place of supply: ${esc(v.placeOfSupply)}.</li>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${esc(v.number)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a; background: #fff; }
  .sheet { max-width: 760px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 16px; }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: .02em; text-transform: uppercase; }
  .number { font-size: 15px; font-weight: 600; }
  .muted { color: #555; }
  .seller { text-align: right; font-weight: 600; font-size: 15px; }
  .label { text-transform: uppercase; letter-spacing: .08em; font-size: 11px; color: #666; margin: 24px 0 4px; }
  .paid { display: inline-block; margin-top: 6px; padding: 2px 8px; border: 1px solid #1a1a1a;
          font-size: 12px; font-weight: 700; letter-spacing: .08em; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: left; padding: 8px 6px; }
  thead th { border-bottom: 1px solid #ccc; font-size: 11px; text-transform: uppercase;
             letter-spacing: .06em; color: #666; }
  tbody td { border-bottom: 1px solid #eee; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot th { text-align: right; font-weight: 400; color: #444; }
  tfoot .grand th, tfoot .grand td { border-top: 2px solid #1a1a1a; font-weight: 700; font-size: 16px; padding-top: 12px; }
  ul.notes { margin: 24px 0 0; padding-left: 18px; color: #555; font-size: 13px; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div>
      <h1>Invoice</h1>
      <div class="number">${esc(v.number)}</div>
      <div class="muted">Issued ${esc(day(v.issuedAt))}</div>
      ${period}
      ${v.status === 'PAID' ? '<div class="paid">PAID</div>' : ''}
    </div>
    <div class="seller">${esc(v.sellerName)}</div>
  </header>
  <div class="label">Billed to</div>
  <div>${esc(v.billedTo.name)}</div>
  <div class="muted">${esc(v.billedTo.country)}${v.billedTo.taxId ? ` - Tax ID ${esc(v.billedTo.taxId)}` : ''}</div>
  ${v.billedTo.email ? `<div class="muted">${esc(v.billedTo.email)}</div>` : ''}
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
    <tbody>
${rows}
    </tbody>
    <tfoot>
      <tr><th colspan="3">Subtotal</th><td class="num">${money(v.subtotalMinor)}</td></tr>
      ${taxRows}
      <tr class="grand"><th colspan="3">Total</th><td class="num">${money(v.totalMinor)}</td></tr>
    </tfoot>
  </table>
  <ul class="notes">
    ${taxNote}
    ${supply}
    <li>This invoice is for an ETicketsGo plan or credits. It is not a ticket receipt.</li>
  </ul>
</div>
</body>
</html>`;
}
