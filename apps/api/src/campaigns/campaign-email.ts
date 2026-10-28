import { DEFAULT_LOCALE, isLocale, t, type Locale } from '@eticketsgo/i18n';
import {
  EMAIL_PALETTE,
  emailWordmark,
  escapeHtml,
  safeHref,
} from '../notifications/templates/email-html';
import type { CampaignBlock } from './campaign-content';
import { operatorLine } from '../common/operator-line';

/**
 * A campaign email, as HTML and as text.
 *
 * Same shell, palette, wordmark and escaping as every other email (`email-html.ts`), with the
 * parts a campaign needs that a notification never did: an organizer's name and logo, an event
 * card, more than one block. The rules are the same and stricter:
 *
 *   - every text value is escaped, here and only here;
 *   - every link goes through `link()`, which returns the tracked URL for an owned host or
 *     null, and a null link is not rendered at all (the words stay, the link goes);
 *   - images are URLs this platform serves (an event poster, an organizer logo), already
 *     resolved by the caller, and are checked with `safeHref` once more;
 *   - the footer is not optional: who sent it, why the reader got it, how to stop it, and who
 *     operates the platform. A campaign without an unsubscribe link is refused by the caller
 *     before it gets here.
 */

const { BRAND, INK, BODY_TEXT, MUTED, BORDER, PAGE_BG, CARD_BG, FONT } = EMAIL_PALETTE;

export interface RenderEvent {
  title: string;
  /** Already formatted for the reader, in the event's own time zone. */
  when: string | null;
  venue: string | null;
  imageUrl: string | null;
  bookUrl: string;
}

export interface CampaignRenderInput {
  locale: string;
  subject: string;
  previewText: string | null;
  blocks: CampaignBlock[];
  purpose: string;
  organizer: { name: string; logoUrl: string | null };
  /** The campaign's main event, for an `image` block with source EVENT. */
  mainEventImageUrl: string | null;
  events: Record<string, RenderEvent>;
  /** Maps a target to the URL the email carries, or null to drop the link. */
  link: (target: string) => string | null;
  unsubscribeUrl: string;
  /**
   * "Unsubscribe from all marketing email": a signed platform-wide link that stops every
   * organizer's campaigns and ETicketsGo marketing, never tickets or receipts. Printed beside
   * the organizer's own link. The List-Unsubscribe header stays organizer-scoped.
   */
  unsubscribeAllUrl: string;
  /**
   * The DeepTrics company the footer names. `country` (IN or US) gives the owner's sentence
   * for that company, "ETicketsGo is operated in India by ..."; without it the footer keeps the
   * plain "ETicketsGo is operated by ...".
   */
  platform: { legalName: string; country?: string | null; postalAddress: string | null };
  isTest?: boolean;
}

export interface RenderedCampaign {
  html: string;
  text: string;
}

function localeOf(raw: string): Locale {
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

function p(text: string, style = ''): string {
  return `<p style="font-family:${FONT};margin:0 0 14px;color:${BODY_TEXT};font-size:15px;line-height:1.6;${style}">${escapeHtml(
    text,
  ).replace(/\r?\n/g, '<br />')}</p>`;
}

function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;">
            <tr><td align="center" bgcolor="${BRAND}" style="border-radius:8px;">
              <a href="${escapeHtml(href)}" style="font-family:${FONT};display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escapeHtml(
                label,
              )}</a>
            </td></tr>
          </table>`;
}

function image(src: string, alt: string): string {
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:10px;margin:0 0 18px;" />`;
}

/** The HTML and text of one block, or null when it renders nothing (a dropped link, no image). */
function renderBlock(
  block: CampaignBlock,
  input: CampaignRenderInput,
  locale: Locale,
): { html: string; text: string } | null {
  switch (block.type) {
    case 'heading':
      return {
        html: `<h2 style="font-family:${FONT};margin:0 0 12px;color:${INK};font-size:20px;line-height:1.35;font-weight:700;">${escapeHtml(
          block.text,
        )}</h2>`,
        text: block.text.toUpperCase(),
      };
    case 'paragraph':
      return { html: p(block.text), text: block.text };
    case 'divider':
      return {
        html: `<hr style="border:0;border-top:1px solid ${BORDER};margin:8px 0 18px;" />`,
        text: '----',
      };
    case 'image': {
      const src = safeHref(
        block.source === 'EVENT' ? input.mainEventImageUrl : input.organizer.logoUrl,
      );
      return src ? { html: image(src, block.alt), text: '' } : null;
    }
    case 'button': {
      const href = input.link(block.url);
      if (!href) return { html: '', text: '' };
      return { html: button(block.label, href), text: `${block.label}: ${href}` };
    }
    case 'offer': {
      const code = block.code
        ? `<p style="font-family:${FONT};margin:0 0 6px;color:${MUTED};font-size:12px;letter-spacing:0.5px;text-transform:uppercase;">${escapeHtml(
            t(locale, 'emails.campaign.code'),
          )}</p><p style="font-family:${FONT};margin:0;color:${INK};font-size:22px;font-weight:800;letter-spacing:2px;">${escapeHtml(
            block.code,
          )}</p>`
        : '';
      return {
        html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 18px;border:1px dashed ${BRAND};border-radius:10px;border-collapse:separate;"><tr><td style="padding:16px 18px;">${p(
          block.text,
          'margin-bottom:8px;',
        )}${code}</td></tr></table>`,
        text: block.code
          ? `${block.text}\n${t(locale, 'emails.campaign.code')}: ${block.code}`
          : block.text,
      };
    }
    case 'event': {
      const ev = input.events[block.eventId];
      if (!ev) return null;
      const href = input.link(ev.bookUrl);
      const img = safeHref(ev.imageUrl);
      const rows = [
        ev.when ? [t(locale, 'emails.campaign.when'), ev.when] : null,
        ev.venue ? [t(locale, 'emails.campaign.where'), ev.venue] : null,
      ].filter((r): r is [string, string] => !!r);
      const rowsHtml = rows
        .map(
          ([label, value]) =>
            `<tr><td style="font-family:${FONT};padding:4px 12px 4px 0;color:${MUTED};font-size:14px;vertical-align:top;white-space:nowrap;">${escapeHtml(
              label,
            )}</td><td style="font-family:${FONT};padding:4px 0;color:${INK};font-size:14px;font-weight:600;vertical-align:top;">${escapeHtml(
              value,
            )}</td></tr>`,
        )
        .join('');
      const bookLabel = t(locale, 'emails.campaign.book');
      return {
        html: `<table role="presentation" class="etg-rows" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 18px;border-collapse:separate;background:#F9FAFB;border:1px solid ${BORDER};border-radius:10px;">
            <tr><td style="padding:16px;">
              ${img ? image(img, ev.title) : ''}
              <p style="font-family:${FONT};margin:0 0 8px;color:${INK};font-size:17px;font-weight:700;line-height:1.4;">${escapeHtml(
                ev.title,
              )}</p>
              ${rowsHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;border-collapse:collapse;">${rowsHtml}</table>` : ''}
              ${href ? button(bookLabel, href) : ''}
            </td></tr>
          </table>`,
        text: [ev.title, ...rows.map(([l, v]) => `${l}: ${v}`), href ? `${bookLabel}: ${href}` : '']
          .filter(Boolean)
          .join('\n'),
      };
    }
    default:
      return null;
  }
}

/** The whole campaign email. Pure: the same input gives the same bytes. */
export function renderCampaignEmail(input: CampaignRenderInput): RenderedCampaign {
  const locale = localeOf(input.locale);
  const org = input.organizer.name;
  const topicKey = `emails.campaign.topic.${input.purpose}`;
  const topic = t(locale, topicKey);
  const why = t(locale, 'emails.campaign.why', {
    organizer: org,
    topic: topic === topicKey ? t(locale, 'emails.campaign.topic.ORGANIZER_UPDATES') : topic,
  });
  const sentBy = t(locale, 'emails.campaign.sentBy', { organizer: org });
  const operator =
    input.platform.country === 'IN' || input.platform.country === 'US'
      ? operatorLine(locale, {
          legalName: input.platform.legalName,
          country: input.platform.country,
        })
      : t(locale, 'emails.campaign.operator', { legalName: input.platform.legalName });
  const unsubLabel = t(locale, 'emails.campaign.unsubscribe', { organizer: org });
  const unsubPrompt = t(locale, 'emails.campaign.unsubscribePrompt');
  const unsubHref = safeHref(input.unsubscribeUrl);
  if (!unsubHref) throw new Error('A campaign email needs a working unsubscribe link.');
  const unsubAllLabel = t(locale, 'emails.campaign.unsubscribeAll');
  const unsubAllHref = safeHref(input.unsubscribeAllUrl);
  if (!unsubAllHref) {
    throw new Error('A campaign email needs a working "unsubscribe from all marketing" link.');
  }

  const parts = input.blocks
    .map((b) => renderBlock(b, input, locale))
    .filter((r): r is { html: string; text: string } => !!r);
  const logo = safeHref(input.organizer.logoUrl);
  const banner = input.isTest
    ? `<tr><td style="padding:10px 32px;background:#FFF7E6;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${INK};">${escapeHtml(
        t(locale, 'emails.campaign.testBanner'),
      )}</td></tr>`
    : '';
  const preheader = input.previewText ?? '';

  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(input.subject)}</title>
    <style>
      @media (prefers-color-scheme: dark) {
        .etg-page { background: #0B0F19 !important; }
        .etg-card { background: #151A24 !important; border-color: #2A313D !important; }
        .etg-ink, .etg-ink * { color: #F3F4F6 !important; }
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
      preheader,
    )}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>
    <table role="presentation" class="etg-page" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE_BG};border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:28px 12px;">
          <table role="presentation" class="etg-card" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;border-collapse:separate;">
            ${banner}
            <tr>
              <td class="etg-pad etg-ink" style="padding:22px 32px;border-bottom:1px solid ${BORDER};">
                ${
                  logo
                    ? `<img src="${escapeHtml(logo)}" alt="" width="40" height="40" style="display:inline-block;width:40px;height:40px;border-radius:8px;vertical-align:middle;margin-right:10px;border:0;" />`
                    : ''
                }<span style="font-family:${FONT};font-size:17px;font-weight:700;color:${INK};vertical-align:middle;">${escapeHtml(
                  org,
                )}</span>
              </td>
            </tr>
            <tr>
              <td class="etg-pad etg-ink" style="padding:28px 32px 8px;">
                ${parts.map((x) => x.html).join('\n                ')}
              </td>
            </tr>
            <tr>
              <td class="etg-pad" style="padding:6px 32px 26px;border-top:1px solid ${BORDER};">
                <p style="font-family:${FONT};margin:16px 0 6px;color:${MUTED};font-size:12px;line-height:1.6;">${escapeHtml(
                  why,
                )}</p>
                <p style="font-family:${FONT};margin:0 0 6px;color:${MUTED};font-size:12px;line-height:1.6;">${escapeHtml(
                  unsubPrompt,
                )} <a href="${escapeHtml(unsubHref)}" style="color:${BRAND};text-decoration:underline;">${escapeHtml(
                  unsubLabel,
                )}</a> &middot; <a href="${escapeHtml(unsubAllHref)}" style="color:${BRAND};text-decoration:underline;">${escapeHtml(
                  unsubAllLabel,
                )}</a></p>
                <p style="font-family:${FONT};margin:0 0 6px;color:${MUTED};font-size:12px;line-height:1.6;">${escapeHtml(
                  sentBy,
                )} ${escapeHtml(operator)}${
                  input.platform.postalAddress ? ` ${escapeHtml(input.platform.postalAddress)}` : ''
                }</p>
                <p style="font-family:${FONT};margin:10px 0 0;">${emailWordmark()}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    input.isTest ? t(locale, 'emails.campaign.testBanner') : '',
    org,
    '',
    ...parts.map((x) => x.text).filter(Boolean),
    '',
    '--',
    why,
    `${unsubLabel}: ${unsubHref}`,
    `${unsubAllLabel}: ${unsubAllHref}`,
    `${sentBy} ${operator}${input.platform.postalAddress ? ` ${input.platform.postalAddress}` : ''}`,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
    .trim();

  return { html, text };
}
