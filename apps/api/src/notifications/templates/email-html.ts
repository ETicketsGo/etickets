/**
 * The HTML an email is actually rendered as.
 *
 * ── WHY THIS IS NOT A TEMPLATE ENGINE ──────────────────────────────────────────────
 * Every message this platform sends is the same shape: a heading, a sentence or two, some
 * facts about a booking, one thing to click, and a footer saying why the mail arrived. That
 * is a function, not a template language, and writing it as one keeps the escaping in a
 * single place instead of at every interpolation point in twenty-six files.
 *
 * ── WHY IT LOOKS LIKE 2005 ─────────────────────────────────────────────────────────
 * Tables, inline styles, no external stylesheet and no remote images. Outlook renders with
 * Word, Gmail strips <style> in some contexts and re-writes classes, and a linked stylesheet
 * simply does not load. The layout therefore carries its styling on each element, and the
 * <style> block only adds progressive extras (dark mode, one mobile tweak) that no reader
 * depends on. There is deliberately NO logo image: a remote image is a tracking pixel by
 * another name, is blocked by default in most clients, and a wordmark in text always renders.
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────────────
 * Nothing that reaches this file is trusted. Every value is escaped, and a link is rendered
 * as a link only when it is an http(s) URL - a payload is assembled by whichever service is
 * sending, and `javascript:` in a mail under this platform's name is somebody else's
 * phishing campaign with our branding on it. See `link-safety.ts` for the origin check that
 * has already run by this point; this is the second lock on the same door.
 */

/** Brand colour, from the design tokens the web apps use (--action-primary). */
const BRAND = '#1A5CEA';
const INK = '#111827';
const BODY_TEXT = '#374151';
const MUTED = '#6B7280';
const BORDER = '#E5E7EB';
const PAGE_BG = '#F4F5F7';
const CARD_BG = '#FFFFFF';
/**
 * The font, stated on every text element.
 *
 * Not a nicety: a mail client that is given no font-family renders the message in its
 * default serif, and the first render of this layout in a browser came out in Times. Web
 * fonts are not an option in email, so this is the usual native stack, ending in a generic
 * family so something sensible happens on a client that has none of them.
 */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/** One fact about the thing the mail is about: "When", "Friday 2 Oct 2026, 7:30 pm (IST)". */
export interface EmailRow {
  label: string;
  value: string;
}

export interface EmailView {
  /** The reader's language, for the document's `lang`. A screen reader reads French as
   * French only if the document says so. */
  locale: string;
  /** The subject line, repeated into <title> for clients that show it. */
  subject: string;
  /** The grey preview line a client shows beside the subject. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  rows: EmailRow[];
  cta: { label: string; url: string } | null;
  /** Why this message arrived. Not marketing copy - the answer to "why am I getting this". */
  footerNote: string;
  help: { prompt: string; label: string; url: string } | null;
  legal: string;
}

/** HTML-escapes a value. Ampersand first, or the other escapes are escaped again. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A URL safe to put in an href, or null.
 *
 * Only http and https. Everything else - `javascript:`, `data:`, a relative path that a mail
 * client would resolve against nothing - is dropped, and the message goes without the link.
 */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The bare hostname, for the small print under a button: "qa.eticketsgo.com". */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function paragraph(text: string): string {
  return `<p style="font-family:${FONT};margin:0 0 14px;color:${BODY_TEXT};font-size:15px;line-height:1.6;">${escapeHtml(
    text,
  )}</p>`;
}

/**
 * The facts, as a two-column table.
 *
 * Labels are a fixed narrow column so the values line up, and every cell aligns TOP: a long
 * venue address wrapping onto three lines must not drag its label down the middle of them.
 */
function rowsTable(rows: EmailRow[]): string {
  if (!rows.length) return '';
  const cells = rows
    .map(
      (row) => `<tr>
              <td style="font-family:${FONT};padding:8px 12px 8px 0;color:${MUTED};font-size:14px;line-height:1.5;vertical-align:top;white-space:nowrap;">${escapeHtml(
                row.label,
              )}</td>
              <td style="font-family:${FONT};padding:8px 0;color:${INK};font-size:14px;line-height:1.5;font-weight:600;vertical-align:top;">${escapeHtml(
                row.value,
              )}</td>
            </tr>`,
    )
    .join('\n');
  return `<table role="presentation" class="etg-rows" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 18px;border-collapse:collapse;background:#F9FAFB;border:1px solid ${BORDER};border-radius:10px;">
            <tr><td style="padding:6px 16px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
${cells}
              </table>
            </td></tr>
          </table>`;
}

/**
 * The button.
 *
 * Built out of a table rather than a styled <a>, because Outlook ignores padding on inline
 * elements and would render the call to action as bare underlined text. The URL is printed
 * underneath as well: a client that strips the button, or a reader who does not trust one,
 * still has the address - and seeing the host is how somebody spots that a mail is not from
 * us at all.
 */
function ctaBlock(cta: { label: string; url: string }): string {
  const href = escapeHtml(cta.url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;">
            <tr><td align="center" bgcolor="${BRAND}" style="border-radius:8px;">
              <a href="${href}" style="font-family:${FONT};display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escapeHtml(
                cta.label,
              )}</a>
            </td></tr>
          </table>
          <p style="font-family:${FONT};margin:0 0 18px;color:${MUTED};font-size:12px;line-height:1.5;word-break:break-all;">${escapeHtml(
            cta.url,
          )}</p>`;
}

/**
 * The whole message.
 *
 * `preheader` is the grey line a client prints beside the subject in the inbox list. Without
 * one, clients take the first text in the document, which for a branded mail is the wordmark
 * - so every message would preview as "ETicketsGo ETicketsGo". It is hidden in the body with
 * the usual belt-and-braces of zero size, zero opacity and a run of zero-width spaces that
 * stops the following text being pulled into the preview.
 */
export function renderEmailHtml(view: EmailView): string {
  const help = view.help && safeHref(view.help.url) ? view.help : null;
  const cta = view.cta && safeHref(view.cta.url) ? view.cta : null;

  return `<!doctype html>
<html lang="${escapeHtml(view.locale)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(view.subject)}</title>
    <style>
      @media (prefers-color-scheme: dark) {
        .etg-page { background: #0B0F19 !important; }
        .etg-card { background: #151A24 !important; border-color: #2A313D !important; }
        .etg-ink, .etg-ink *, .etg-mark span { color: #F3F4F6 !important; }
        .etg-mark span span { color: #6E9BFF !important; }
        .etg-rows { background: #1B212C !important; border-color: #2A313D !important; }
      }
      @media (max-width: 620px) {
        .etg-card { border-radius: 0 !important; }
        .etg-pad { padding: 24px 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${PAGE_BG};font-family:${FONT};">
    <div style="font-family:${FONT};display:none;font-size:1px;color:${PAGE_BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(
      view.preheader,
    )}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>
    <table role="presentation" class="etg-page" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE_BG};border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:28px 12px;">
          <table role="presentation" class="etg-card" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;border-collapse:separate;">
            <tr>
              <td class="etg-pad etg-mark" style="padding:22px 32px;border-bottom:1px solid ${BORDER};">
                <span style="font-family:${FONT};font-size:17px;font-weight:700;color:${INK};letter-spacing:-0.2px;">ETickets<span style="color:${BRAND};">Go</span></span>
              </td>
            </tr>
            <tr>
              <td class="etg-pad etg-ink" style="padding:28px 32px 8px;">
                <h1 style="font-family:${FONT};margin:0 0 14px;color:${INK};font-size:21px;line-height:1.35;font-weight:700;">${escapeHtml(
                  view.heading,
                )}</h1>
                ${view.paragraphs.map(paragraph).join('\n                ')}
                ${rowsTable(view.rows)}
                ${cta ? ctaBlock(cta) : ''}
              </td>
            </tr>
            <tr>
              <td class="etg-pad" style="padding:6px 32px 26px;border-top:1px solid ${BORDER};">
                <p style="font-family:${FONT};margin:16px 0 6px;color:${MUTED};font-size:12px;line-height:1.6;">${escapeHtml(
                  view.footerNote,
                )}</p>
                ${
                  help
                    ? `<p style="font-family:${FONT};margin:0 0 6px;color:${MUTED};font-size:12px;line-height:1.6;">${escapeHtml(
                        help.prompt,
                      )} <a href="${escapeHtml(
                        help.url,
                      )}" style="color:${BRAND};text-decoration:underline;">${escapeHtml(
                        help.label,
                      )}</a></p>`
                    : ''
                }
                <p style="font-family:${FONT};margin:0;color:${MUTED};font-size:12px;line-height:1.6;">${escapeHtml(
                  view.legal,
                )}${help ? ` &middot; ${escapeHtml(hostOf(help.url))}` : ''}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
