import { env } from './env';

/**
 * Legal and support URLs.
 *
 * Derived from ONE configured web host rather than scattered as literals across screens.
 * The reason is concrete: these must differ per environment (a QA build must not link a
 * tester to the production terms), and both app stores require the privacy policy URL
 * in the listing to match the one in the app. Hard-coded strings drift from both.
 *
 * The paths mirror the customer-web routes. If a page moves, it moves here once.
 */
const LEGAL_PATHS = {
  terms: '/legal/terms',
  privacy: '/legal/privacy',
  refunds: '/legal/refund-policy',
  support: '/support',
} as const;

export type LegalDocument = keyof typeof LEGAL_PATHS;

/**
 * Fallback host for builds with no EXPO_PUBLIC_WEB_HOST.
 *
 * Production is the safe default here, unlike everywhere else in this app: a legal link
 * that 404s is worse than one pointing at the canonical published document, and these
 * pages are public, static and identical in content across environments.
 */
const FALLBACK_HOST = 'eticketsgo.com';

export function legalUrl(document: LegalDocument): string {
  const host = env.webHost ?? FALLBACK_HOST;
  return `https://${host}${LEGAL_PATHS[document]}`;
}

/** Every legal link, for rendering a settings section. */
export function legalLinks(): { key: LegalDocument; label: string; url: string }[] {
  return [
    { key: 'terms', label: 'Terms of service', url: legalUrl('terms') },
    { key: 'privacy', label: 'Privacy policy', url: legalUrl('privacy') },
    { key: 'refunds', label: 'Refund & cancellation policy', url: legalUrl('refunds') },
  ];
}
