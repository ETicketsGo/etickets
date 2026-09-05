import { DEFAULT_LOCALE, HTML_LANG, isLocale, t, type Locale } from '@eticketsgo/i18n';
import { money as formatMoney, moneyFractionDigits } from '@eticketsgo/shared-types';
import type { ReceiptDocument } from './receipt-document';

/**
 * Render an issued document as a standalone, printable HTML page.
 *
 * Deliberately a plain string template with no dependencies: this markup is what a customer
 * prints or saves as a PDF via the browser, and what an accountant may keep for years. It
 * must render identically with no network access, no fonts to fetch, and no JavaScript.
 */

/**
 * Which regional conventions to format money with.
 *
 * ── WHY `en` IS `en` HERE AND `en-IN` IN THE EMAIL TEMPLATES ───────────────────────
 * Both were chosen deliberately, separately, and both are covered by tests: the receipt has
 * always grouped digits the plain-`en` way (`¥104,040`) and the notification templates have
 * always used Indian grouping (`₹1,04,040`). They disagree, and they disagreed before this
 * change.
 *
 * Unifying them is a real improvement and is NOT being done here. Whichever way it goes, it
 * changes how money reads on financial documents for every existing customer, and that is a
 * product decision about the Indian market — not something to slip in as a side effect of
 * adding French. Adding `fr-CA` is additive and affects nobody who is not reading French.
 */
const FORMAT_LOCALE: Record<Locale, string> = {
  en: 'en',
  'fr-CA': 'fr-CA',
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
 * ── WHY THIS NO LONGER FORMATS ANYTHING ITSELF ─────────────────────────────────────
 * It used to build its own `Intl.NumberFormat`, and it was one of five places that did.
 * The storefront printed ₹355 for a cart this document printed as ₹355.22 — the same
 * booking, two numbers, and the customer holding the one that disagreed. It also grouped
 * INR the plain-`en` way (₹104,040) while the notification emails used Indian grouping
 * (₹1,04,040); a comment here recorded that disagreement and deferred it.
 *
 * Both are settled by there being one formatter. `money()` in shared-types is currency-
 * aware and locale-aware, and this passes the document's own locale through.
 *
 * `undefined` for English so the shared formatter picks the locale the CURRENCY calls for
 * — en-IN for rupees, so an Indian receipt finally groups in lakhs like every other surface
 * on the platform. French keeps fr-CA, which was already right.
 */
export function formatMinor(
  amountMinor: number,
  currency: string,
  locale: Locale = DEFAULT_LOCALE,
  fractionDigits?: number,
): string {
  return formatMoney(
    amountMinor,
    currency,
    locale === DEFAULT_LOCALE ? undefined : FORMAT_LOCALE[locale],
    fractionDigits,
  );
}

/**
 * Every amount this document will print, so the column can settle on one number of decimals.
 *
 * A receipt showing "₹300" above "₹55.22" reads as two kinds of number. Gathering them all
 * first means either every figure carries paise or none does.
 */
function documentAmounts(d: ReceiptDocument): number[] {
  return [
    ...d.lines.flatMap((l) => [l.unitPriceMinor, l.lineTotalMinor]),
    d.totals.subtotalMinor,
    d.totals.discountMinor,
    d.totals.feeMinor,
    d.totals.taxMinor,
    d.totals.totalMinor,
    ...(d.taxLines ?? []).flatMap((l) => [l.amountMinor, l.baseMinor]),
  ];
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

/**
 * Render an issued document in the reader's language.
 *
 * ── WHY THE RECEIPT IS NOT AN AFTERTHOUGHT ─────────────────────────────────────────
 * Quebec's Charter of the French Language covers invoices and receipts explicitly, and a
 * French storefront that issues an English receipt is not partial compliance — it is the
 * document the customer actually keeps, and the one an inspector would ask for.
 *
 * `lang` on the <html> element follows the content. A French document declaring `lang="en"`
 * is read aloud by a screen reader in an English voice, which is unintelligible — the same
 * WCAG 3.1.1 criterion the accessibility sweep asserts on every page.
 */
export function renderReceiptHtml(d: ReceiptDocument, localeInput?: string): string {
  const locale: Locale = isLocale(localeInput) ? localeInput : DEFAULT_LOCALE;
  const title = t(locale, `documents.kind.${d.kind}`) ?? t(locale, 'documents.kind.FALLBACK');
  const digits = moneyFractionDigits(documentAmounts(d), d.currency);
  const money = (v: number) => esc(formatMinor(v, d.currency, locale, digits));
  const label = (key: string, values?: Record<string, unknown>) =>
    esc(t(locale, `documents.receipt.${key}`, values));

  const sellerAddress = addressLines(d)
    .map((l) => `<div>${esc(l)}</div>`)
    .join('');

  const registration = d.seller.taxRegistrationNumber
    ? `<div class="reg">${esc(d.seller.taxRegistrationKind ?? t(locale, 'documents.receipt.taxRegistration'))}: <strong>${esc(
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

  /*
    Is the tax INSIDE the total, or added to it?

    Derived from the arithmetic rather than stored, because the document is an immutable
    snapshot written before inclusive tax existed and re-deriving is exact: an exclusive
    receipt foots as subtotal + fee + tax, an inclusive one as subtotal + fee alone.

    This distinction is the whole bug. The tax rows used to sit BETWEEN the booking fee and
    the total, which is right when the tax is added and badly wrong when it is not: an Indian
    receipt for a ₹100 ticket showed ₹100 + ₹7.10 + ₹8.17 + ₹8.17 above a total of ₹107.10,
    so anybody adding the column got ₹123.44 and a document that does not foot. A receipt
    that does not add up is not a presentation preference; it is a receipt nobody can check.
  */
  const taxTotal = d.taxLines.reduce((sum, t) => sum + t.amountMinor, 0);
  const taxIsIncluded =
    taxTotal > 0 &&
    d.totals.subtotalMinor - Math.abs(d.totals.discountMinor) + d.totals.feeMinor ===
      d.totals.totalMinor;

  const exclusiveTaxRows =
    d.taxLines.length && !taxIsIncluded
      ? d.taxLines
          .map(
            (t) =>
              `<tr><th colspan="3">${esc(t.label)} @ ${esc(formatRate(t.rateBasisPoints))} on ${money(
                t.baseMinor,
              )}</th><td class="num">${money(t.amountMinor)}</td></tr>`,
          )
          .join('')
      : '';

  /*
    Below the total, and labelled as already in it.

    "Includes CGST @ 9% on ₹90.76" states the same figures the tax authority needs while
    making it unambiguous that they are a breakdown of the number above, not an addition to
    it — which is exactly how an Indian ticket receipt reads.
  */
  const inclusiveTaxRows = taxIsIncluded
    ? d.taxLines
        // `line`, not `t` — `t` is the translator in this scope, and shadowing it here
        // silently turns a tax line into a function call.
        .map(
          (line) =>
            `<tr class="incl"><th colspan="3">${esc(
              t(locale, 'documents.receipt.taxIncluded', {
                label: line.label,
                rate: formatRate(line.rateBasisPoints),
                base: money(line.baseMinor),
              }),
            )}</th><td class="num">${money(line.amountMinor)}</td></tr>`,
        )
        .join('')
    : '';

  const notes = d.notes.map((n) => `<li>${esc(n)}</li>`).join('');

  const reverses = d.reverses
    ? /*
         The document number is escaped, then the sentence around it is escaped, and only
         then is the emphasis added back. Interpolating `<strong>` INTO the translated
         sentence and escaping the result would print the tags to the customer; escaping the
         sentence but not the number would let a document number decide the page's markup.
       */
      `<div class="reverses">${esc(
        t(locale, 'documents.receipt.reverses', { reference: ' ' }),
      ).replace(' ', `<strong>${esc(d.reverses.number)}</strong>`)} — ${esc(
        new Date(d.reverses.issuedAt).toISOString().slice(0, 10),
      )}</div>`
    : '';

  return `<!doctype html>
<html lang="${HTML_LANG[locale]}">
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
      <div class="label">${label('billedTo')}</div>
      <div>${esc(d.buyer.name ?? '—')}</div>
      <div class="muted">${esc(d.buyer.email ?? '')}</div>
    </div>
    <div>
      <div class="label">${label('order')}</div>
      <div>${esc(d.order.reference ?? d.order.bookingId)}</div>
      ${d.order.eventTitle ? `<div class="muted">${esc(d.order.eventTitle)}</div>` : ''}
      ${d.order.venue ? `<div class="muted">${esc(d.order.venue)}</div>` : ''}
    </div>
  </div>

  ${reverses}

  <table>
    <thead>
      <tr><th>${label('description')}</th><th class="num">${label('qty')}</th><th class="num">${label('unit')}</th><th class="num">${label('amount')}</th></tr>
    </thead>
    <tbody>${lineRows}</tbody>
    <tfoot>
      ${totalRow(label('subtotal'), d.totals.subtotalMinor)}
      ${d.totals.discountMinor !== 0 ? totalRow(label('discount'), -Math.abs(d.totals.discountMinor)) : ''}
      ${
        /*
          Itemised when the parts are known and foot exactly, one line when they are not.

          The receipt used to print the whole customer fee under the label "Booking fee",
          which was the wrong name for it: on a ₹2,999 ticket that single line said ₹80.38
          when the booking fee was ₹20 and the rest was payment processing. A buyer comparing
          the receipt against the checkout screen — where the two were listed separately —
          found three different presentations of the same money across three screens.
        */
        d.feeParts &&
        d.feeParts.bookingFeeMinor + d.feeParts.paymentFeeMinor === d.totals.feeMinor &&
        d.totals.feeMinor !== 0
          ? `${d.feeParts.bookingFeeMinor !== 0 ? totalRow(label('bookingFee'), d.feeParts.bookingFeeMinor) : ''}${
              d.feeParts.paymentFeeMinor !== 0
                ? totalRow(label('paymentFee'), d.feeParts.paymentFeeMinor)
                : ''
            }`
          : d.totals.feeMinor !== 0
            ? totalRow(label('bookingFee'), d.totals.feeMinor)
            : ''
      }
      ${exclusiveTaxRows}
      ${totalRow(
        d.kind === 'CREDIT_NOTE' ? label('totalRefunded') : label('total'),
        d.totals.totalMinor,
        'grand',
      )}
      ${inclusiveTaxRows}
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
