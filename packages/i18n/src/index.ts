import { DEFAULT_LOCALE, type Locale } from './locales';

import enCommon from './messages/en/common.json';
import enDocuments from './messages/en/documents.json';
import enEmails from './messages/en/emails.json';
import enStorefront from './messages/en/storefront.json';

import frCommon from './messages/fr-CA/common.json';
import frDocuments from './messages/fr-CA/documents.json';
import frEmails from './messages/fr-CA/emails.json';
import frStorefront from './messages/fr-CA/storefront.json';

export * from './locales';

/**
 * One catalogue, two very different consumers.
 *
 * The web apps read it through next-intl; the API reads it directly to render receipts and
 * transactional email. Keeping it in a package rather than one copy per app is the whole
 * point: Quebec's Charter covers the storefront AND the receipt AND the email, and two
 * catalogues would drift the first time somebody fixed a wording in one of them.
 */
export const MESSAGES = {
  en: {
    common: enCommon,
    documents: enDocuments,
    emails: enEmails,
    storefront: enStorefront,
  },
  'fr-CA': {
    common: frCommon,
    documents: frDocuments,
    emails: frEmails,
    storefront: frStorefront,
  },
} as const;

export type Namespace = keyof (typeof MESSAGES)['en'];

/** Everything for one locale, as next-intl wants it. */
export function messagesFor(locale: Locale) {
  return MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
}

/**
 * Look a message up by dotted path.
 *
 * Falls back to English for a key the target locale is missing, because a customer reading a
 * mostly-French page with one English line is better served than one reading `emails.body`.
 * That fallback is a runtime safety net and NOT a translation strategy — `catalogue.test.ts`
 * fails the build when the two catalogues disagree, so in practice it never fires.
 */
export function lookup(locale: Locale, path: string): string | undefined {
  return read(MESSAGES[locale] ?? {}, path) ?? read(MESSAGES[DEFAULT_LOCALE], path);
}

function read(root: unknown, path: string): string | undefined {
  let node: unknown = root;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Fill `{placeholders}` and the one plural form the email catalogue uses.
 *
 * ── WHY NOT PULL IN A FULL ICU LIBRARY ─────────────────────────────────────────────
 * The web apps already get real ICU from next-intl. This exists only for the API, whose
 * entire message surface is transactional email and receipts, and which needs exactly two
 * features: interpolation and `plural`. A formatter for two features is smaller than the
 * dependency, and — the deciding reason — it runs in a NestJS process where adding an
 * intl-polyfill chain to render one email subject is not a trade worth making.
 *
 * Anything more expressive than `{count, plural, one {...} other {...}}` belongs in the web
 * catalogue, and `catalogue.test.ts` fails if a construct this cannot render appears here.
 */
export function format(template: string, values: Record<string, unknown> = {}): string {
  // Plurals first: their bodies contain `#`, and the simple pass below would not know it.
  const withPlurals = template.replace(
    /\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\s*\}/g,
    (_match, name: string, one: string, other: string) => {
      const n = Number(values[name] ?? 0);
      return (n === 1 ? one : other).replace(/#/g, String(n));
    },
  );

  return withPlurals.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = values[name];
    // An absent value leaves the placeholder visible rather than printing "undefined": a
    // literal `{reference}` in a support ticket names the bug, "undefined" hides it.
    return v === undefined || v === null ? match : String(v);
  });
}

/** Look up and interpolate in one step — what the API actually calls. */
export function t(locale: Locale, path: string, values?: Record<string, unknown>): string {
  const template = lookup(locale, path);
  return template === undefined ? path : format(template, values);
}
