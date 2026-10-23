'use client';

// The shared providers (React Query + toasts), plus the one thing only the customer app
// needs: a single city preference the header chip and every browse page agree on. The
// organizer and admin consoles are not location-filtered, so this stays out of WebProviders.
import { useLocale, useTranslations } from 'next-intl';
import { CityProvider, WebProviders, type HumanCheckLabels } from '@eticketsgo/web-kit';

export function Providers({ children }: { children: React.ReactNode }) {
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
      <CityProvider>{children}</CityProvider>
    </WebProviders>
  );
}
