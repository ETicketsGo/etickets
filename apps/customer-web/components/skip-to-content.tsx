'use client';

import { useTranslations } from 'next-intl';

/**
 * The first thing a keyboard user reaches, and it has to be in their language.
 *
 * WCAG 2.4.1. It was a hardcoded English string in the layout; a French page whose very
 * first focusable control says "Skip to content" announces the mistake before anything else
 * on the page has rendered.
 *
 * It sits above every shell, so it scopes the brand layer itself: focused, it is the brand's
 * ink button with the brand focus ring, not the old blue one.
 */
export function SkipToContent() {
  const t = useTranslations('common.nav');
  return (
    <a
      href="#main"
      data-brand="customer"
      className="sr-only font-brand-text focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-brand-control focus:bg-brand-action focus:px-4 focus:py-2 focus:text-brand-ui focus:font-semibold focus:text-brand-on-action focus:outline-none focus:ring-2 focus:ring-brand-focus focus:ring-offset-2 focus:ring-offset-brand-canvas"
    >
      {t('skipToContent')}
    </a>
  );
}
