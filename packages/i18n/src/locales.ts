/**
 * The languages this product is sold in.
 *
 * ── WHY fr-CA AND NOT fr ───────────────────────────────────────────────────────────
 * The obligation driving this is Quebec's Charter of the French Language, and Quebec French
 * is not interchangeable with French French for commerce. `magasiner` not `faire du shopping`,
 * `courriel` not `email`, `panier` for a cart, and — the one that matters most here —
 * `billetterie` and `réservation` carry the meanings the OQLF expects. Tagging the catalogue
 * `fr-CA` also makes `Intl` format money as `123,45 $` with the sign trailing and a
 * non-breaking space, which is the Canadian convention and not the French one.
 *
 * A future `fr-FR` would be a sibling, never a rename of this.
 */
export const LOCALES = ['en', 'fr-CA'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * What somebody gets when they have expressed no preference.
 *
 * English, and this is a deliberate choice rather than an oversight: the platform sells in
 * India today and Quebec is the market being prepared for. Whether the DEFAULT should flip
 * per-market is a routing decision (see `resolveLocale`), not a property of the catalogue.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/** IETF tag → the `lang` attribute value. Identical today; kept as a seam. */
export const HTML_LANG: Record<Locale, string> = {
  en: 'en',
  'fr-CA': 'fr-CA',
};

/** What each language calls itself. Never translated — a language picker lists endonyms. */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'English',
  'fr-CA': 'Français',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Pick a locale from what we know about the request, most trustworthy source first.
 *
 * ── ORDER MATTERS, AND THIS IS THE ORDER ───────────────────────────────────────────
 * 1. An explicit choice the person made and we stored. Nothing outranks somebody telling us.
 * 2. The URL. A shared `/fr-CA/...` link has to render in French for whoever opens it, even
 *    on a browser set to English — otherwise a French speaker cannot send a French page to
 *    anybody, which is most of the point of having them.
 * 3. `Accept-Language`, matched loosely so `fr`, `fr-FR` and `fr-CA` all land on French. A
 *    French speaker in Paris being served English because their tag was not exactly `fr-CA`
 *    is a worse failure than serving them Quebec French.
 * 4. The default.
 *
 * Deliberately NOT in this list: geography. IP-based language switching is wrong about
 * bilingual people, wrong about travellers, and cannot be overridden by the person it is
 * wrong about.
 */
export function resolveLocale(input: {
  stored?: string | null;
  fromPath?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.stored)) return input.stored;
  if (isLocale(input.fromPath)) return input.fromPath;

  const accepted = parseAcceptLanguage(input.acceptLanguage);
  for (const tag of accepted) {
    if (isLocale(tag)) return tag;
    // `fr`, `fr-FR`, `fr-BE` → the French catalogue we have.
    const base = tag.split('-')[0]?.toLowerCase();
    const match = LOCALES.find((l) => l.split('-')[0].toLowerCase() === base);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/** `fr-CA,fr;q=0.9,en;q=0.8` → ['fr-CA', 'fr', 'en'], best first. */
function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^q=([\d.]+)$/.exec(p.trim())).find(Boolean) as
        RegExpExecArray | undefined;
      return { tag: tag.trim(), q: q ? Number(q[1]) : 1 };
    })
    .filter((x) => x.tag && x.tag !== '*')
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
}
