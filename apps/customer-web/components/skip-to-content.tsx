'use client';

import { useTranslations } from 'next-intl';

/**
 * The first thing a keyboard user reaches, and it has to be in their language.
 *
 * WCAG 2.4.1. It was a hardcoded English string in the layout; a French page whose very
 * first focusable control says "Skip to content" announces the mistake before anything else
 * on the page has rendered.
 */
export function SkipToContent() {
  const t = useTranslations('common.nav');
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-action-primary focus:px-4 focus:py-2 focus:text-action-primary-foreground"
    >
      {t('skipToContent')}
    </a>
  );
}
