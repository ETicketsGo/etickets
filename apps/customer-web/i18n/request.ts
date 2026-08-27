import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { DEFAULT_LOCALE, messagesFor, type Locale } from '@eticketsgo/i18n';
import { routing } from './routing';

/**
 * Messages for the locale this request resolved to.
 *
 * The catalogue is imported from `@eticketsgo/i18n` rather than read from a `messages/`
 * folder in this app, because the same files render the receipt and the confirmation email.
 * A wording fixed on the storefront has to be the wording on the invoice.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale: Locale = hasLocale(routing.locales, requested) ? requested : DEFAULT_LOCALE;
  return {
    locale,
    messages: messagesFor(locale),
  };
});
