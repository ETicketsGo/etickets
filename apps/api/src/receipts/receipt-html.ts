import type { ReceiptDocument } from './receipt-document';

/**
 * Render an issued document as a standalone, printable HTML page.
 *
 * Deliberately a plain string template with no dependencies: this markup is what a customer
 * prints or saves as a PDF via the browser, and what an accountant may keep for years. It
 * must render identically with no network access, no fonts to fetch, and no JavaScript.
 */

const KIND_TITLE: Record<string, string> = {
  TAX_INVOICE: 'Tax invoice',
  RECEIPT: 'Receipt',
  CREDIT_NOTE: 'Credit note',
};

/** Escape for HTML text and attribute contexts. */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format integer minor units for display.
 *
 * `Intl.NumberFormat` does the currency-specific work — including the fact that not every
 * currency has two decimal places, which is precisely the assumption that hand-rolled
 * `/100` formatting bakes in and gets wrong the first time a zero-decimal currency appears.
 */
export function formatMinor(amountMinor: number, currency: string): string {
  try {
    const fmt = new Intl.NumberFormat('en', { style: 'currency', currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(amountMinor / 10 ** digits);
  } catch {
    // Unknown currency code — show the raw minor units rather than a wrong-looking number.
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function formatRate(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2)}%`;
}

function addressLines(d: ReceiptDocument): string[] {
  const a = d.seller.address;
  return [
    a.line1,
    a.line2,
    [a.city, a.region, a.postalCode].filter(Boolean).join(' '),
    a.country,
  ].filter((l): l is string => Boolean(l && l.trim()));
}

export function renderReceiptHtml(d: ReceiptDocument): string {
  const title = KIND_TITLE[d.kind] ?? 'Document';
  const money = (v: number) => esc(formatMinor(v, d.currency));

  const sellerAddress = addressLines(d)
    .map((l) => `<div>${esc(l)}</div>`)
    .join('');

  const registration = d.seller.taxRegistrationNumber
    ? `<div class="reg">${esc(d.seller.taxRegistrationKind ?? 'Tax registration')}: <strong>${esc(
        d.seller.taxRegistrationNumber,
      )}</strong></div>`
    : '';

  const lineRows = d.lines
    .map(
      (l) => `<tr>
        <td>${esc(l.description)}</td>
        <td class="num">${esc(l.quantity)}</td>
        <td class="num">${money(l.unitPriceMinor)}</td>
        <td class="num">${money(l.lineTotalMinor)}</td>
      </tr>`,
    )
    .join('');

  const totalRow = (label: string, value: number, cls = '') =>
    `<tr class="${cls}"><th colspan="3">${esc(label)}</th><td class="num">${money(value)}</td></tr>`;

  const taxRows = d.taxLines.length
    ? d.taxLines
        .map(
          (t) =>
            `<tr><th colspan="3">${esc(t.label)} @ ${esc(formatRate(t.rateBasisPoints))} on ${money(
              t.baseMinor,
            )}</th><td class="num">${money(t.amountMinor)}</td></tr>`,
        )
        .join('')
    : '';

  const notes = d.notes.map((n) => `<li>${esc(n)}</li>`).join('');

  const reverses = d.reverses
    ? `<div class="reverses">Reverses <strong>${esc(d.reverses.number)}</strong> issued ${esc(
        new Date(d.reverses.issuedAt).toISOString().slice(0, 10),
      )}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} ${esc(d.number)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a; background: #fff;
  }
  .sheet { max-width: 760px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 16px; }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: .02em; text-transform: uppercase; }
  .number { font-size: 15px; font-weight: 600; }
  .muted { color: #555; }
  .seller { text-align: right; }
  .seller .name { font-weight: 600; font-size: 15px; }
  .reg { margin-top: 6px; }
  .parties { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; margin: 24px 0; }
  .label { text-transform: uppercase; letter-spacing: .08em; font-size: 11px; color: #666; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 6px; }
  thead th { border-bottom: 1px solid #ccc; font-size: 11px; text-transform: uppercase;
             letter-spacing: .06em; color: #666; }
  tbody td { border-bottom: 1px solid #eee; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot th { text-align: right; font-weight: 400; color: #444; }
  tfoot .grand th, tfoot .grand td { border-top: 2px solid #1a1a1a; font-weight: 700; font-size: 16px; padding-top: 12px; }
  .reverses { margin: 16px 0; padding: 10px 12px; background: #f6f6f6; border-left: 3px solid #999; }
  ul.notes { margin: 24px 0 0; padding-left: 18px; color: #555; font-size: 13px; }
  footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #eee; color: #777; font-size: 12px; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div>
      <h1>${esc(title)}</h1>
      <div class="number">${esc(d.number)}</div>
      <div class="muted">Issued ${esc(new Date(d.issuedAt).toISOString().slice(0, 10))}</div>
    </div>
    <div class="seller">
      <div class="name">${esc(d.seller.legalName || d.seller.name)}</div>
      ${d.seller.legalName && d.seller.legalName !== d.seller.name ? `<div class="muted">trading as ${esc(d.seller.name)}</div>` : ''}
      <div class="muted">${sellerAddress}</div>
      ${registration}
    </div>
  </header>

  <div class="parties">
    <div>
      <div class="label">Billed to</div>
      <div>${esc(d.buyer.name ?? '—')}</div>
      <div class="muted">${esc(d.buyer.email ?? '')}</div>
    </div>
    <div>
      <div class="label">Order</div>
      <div>${esc(d.order.reference ?? d.order.bookingId)}</div>
      ${d.order.eventTitle ? `<div class="muted">${esc(d.order.eventTitle)}</div>` : ''}
      ${d.order.venue ? `<div class="muted">${esc(d.order.venue)}</div>` : ''}
    </div>
  </div>

  ${reverses}

  <table>
    <thead>
      <tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr>
    </thead>
    <tbody>${lineRows}</tbody>
    <tfoot>
      ${totalRow('Subtotal', d.totals.subtotalMinor)}
      ${d.totals.discountMinor !== 0 ? totalRow('Discount', -Math.abs(d.totals.discountMinor)) : ''}
      ${d.totals.feeMinor !== 0 ? totalRow('Booking fee', d.totals.feeMinor) : ''}
      ${taxRows}
      ${totalRow(d.kind === 'CREDIT_NOTE' ? 'Total refunded' : 'Total', d.totals.totalMinor, 'grand')}
    </tfoot>
  </table>

  ${d.reason ? `<p class="muted">Reason: ${esc(d.reason)}</p>` : ''}
  ${notes ? `<ul class="notes">${notes}</ul>` : ''}

  <footer>
    ${d.seller.contactEmail ? `Questions about this document: ${esc(d.seller.contactEmail)}` : ''}
  </footer>
</div>
</body>
</html>`;
}
