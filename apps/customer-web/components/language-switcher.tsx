'use client';

import { useLocale, useTranslations } from 'next-intl';
import { LOCALES, LOCALE_LABEL, type Locale } from '@eticketsgo/i18n';
import { usePathname, useRouter } from '@/i18n/navigation';

/**
 * Switching language, and staying where you were.
 *
 * ── WHY IT SWITCHES IN PLACE RATHER THAN GOING HOME ────────────────────────────────
 * Somebody two thirds of the way through picking seats who realises the page is in the
 * wrong language should not lose the page. `usePathname` from `@/i18n/navigation` returns
 * the route WITHOUT its locale prefix, so the same path can be re-rendered under a different
 * one — `/fr-CA/shows/abc` and `/shows/abc` are the same screen in two languages.
 *
 * ── WHY THE OPTIONS ARE NOT TRANSLATED ─────────────────────────────────────────────
 * "Français", not "French". A language picker lists endonyms, because the person who needs
 * it is by definition the person who cannot read the current language — labelling French as
 * "French" hides it from exactly the reader it is for.
 */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const t = useTranslations('storefront.language');
  const nav = useTranslations('common.nav');
  const locale = useLocale() as Locale;
  const router = useRouter();
  /*
    The route WITHOUT its locale prefix, with dynamic segments already resolved — so
    `/fr-CA/events/jazz-fest` comes back as `/events/jazz-fest` and can be re-pushed under
    the other locale. Reading `window.location` instead would carry the old prefix and
    produce `/en/fr-CA/events/...`.
  */
  const pathname = usePathname();

  return (
    <label className={`inline-flex items-center gap-2 ${className}`}>
      <span className="sr-only">{nav('language')}</span>
      <select
        aria-label={nav('language')}
        value={locale}
        onChange={(e) => {
          const next = e.target.value as Locale;
          router.replace(pathname, { locale: next });
        }}
        className="rounded-md border border-input bg-background-surface px-2 py-1 text-caption text-text-secondary focus:outline-none focus:ring-2 focus:ring-ring/50"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABEL[l]}
          </option>
        ))}
      </select>
      {/*
        The current language is announced but not shown: the select already displays it, and
        a screen reader landing on an unlabelled two-option list has no idea what it changes.
      */}
      <span className="sr-only">{t('current', { language: LOCALE_LABEL[locale] })}</span>
    </label>
  );
}
