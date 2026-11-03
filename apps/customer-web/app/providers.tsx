'use client';

// The shared providers (React Query + toasts), plus the one thing only the customer app
// needs: a single city preference the header chip and every browse page agree on. The
// organizer and admin consoles are not location-filtered, so this stays out of WebProviders.
import { useLocale, useTranslations } from 'next-intl';
import {
  CityProvider,
  WebProviders,
  type CitySeed,
  type HumanCheckLabels,
} from '@eticketsgo/web-kit';
import { ReaderZoneProvider } from '@/lib/reader-zone';

export function Providers({
  children,
  citySeed,
  readerZone,
}: {
  children: React.ReactNode;
  /** The reader's time zone the server rendered with (`lib/reader-zone.tsx`). */
  readerZone?: string;
  /** Where the server rendered this page (`lib/city-seed.ts`). Unset: unknown until resolved. */
  citySeed?: CitySeed;
}) {
  // The human-check dialog speaks the storefront's language (the consoles keep English).
  const t = useTranslations('common.humanCheck');
  const locale = useLocale();
  const humanCheckLabels: HumanCheckLabels = {
    title: t('title'),
    description: t('description'),
    checking: t('checking'),
    failed: t('failed'),
    retry: t('retry'),
    cancel: t('cancel'),
  };
  return (
    <WebProviders
      humanCheckLabels={humanCheckLabels}
      // Turnstile takes a language code; `fr-CA` reads as its French.
      humanCheckLanguage={locale.startsWith('fr') ? 'fr' : 'en'}
    >
      <ReaderZoneProvider zone={readerZone}>
        <CityProvider seed={citySeed}>{children}</CityProvider>
      </ReaderZoneProvider>
    </WebProviders>
  );
}
