import { defineRouting } from 'next-intl/routing';
import { DEFAULT_LOCALE, LOCALES } from '@eticketsgo/i18n';

/**
 * How a locale appears in the URL.
 *
 * ── WHY THE DEFAULT IS UNPREFIXED ──────────────────────────────────────────────────
 * `as-needed` keeps English at `/events` and puts French at `/fr-CA/events`. Every URL that
 * has ever been shared, indexed, printed on a ticket or pasted into a support ticket keeps
 * working, and no redirect chain is introduced on the busiest paths in the product.
 *
 * ── AND WHY FRENCH IS IN THE URL AT ALL ────────────────────────────────────────────
 * A cookie would have been less work. It would also mean one URL serving two languages,
 * which breaks caching, makes the French pages unindexable, and — the reason that actually
 * decides it — means a French speaker cannot send somebody a French page. Sharing a link to
 * an event is most of how people use a ticketing site.
 */
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  /*
    The choice is remembered, and it outranks the browser's header on the next visit.
    Somebody who switched to French once should not have to switch again because their
    laptop is configured in English — see `resolveLocale` for the full order.
  */
  localeCookie: {
    name: 'ETG_LOCALE',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  },
});
