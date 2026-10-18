import { NextIntlClientProvider } from 'next-intl';
import { DEFAULT_LOCALE, messagesFor } from '@eticketsgo/i18n';
import { Providers } from '@/app/providers';
import { SiteChrome } from './site-chrome';
import { SkipToContent } from './skip-to-content';
import { NotFoundView } from './not-found-view';

/**
 * The 404 inside the full storefront shell, for the root `app/not-found.tsx`, which answers
 * outside the locale layout and so has to set up what that layout sets up: the English
 * messages (passed explicitly - there is no locale segment out here to read them from), the
 * providers and the site chrome with its header and footer.
 *
 * Its own component rather than inline in the route file so the test can render exactly this
 * tree and check the header and the footer's legal line are really there.
 */
export function NotFoundInShell({
  initialSignedIn = false,
  buildId = null,
}: {
  initialSignedIn?: boolean;
  buildId?: string | null;
}) {
  return (
    <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
      <SkipToContent />
      <Providers>
        <SiteChrome initialSignedIn={initialSignedIn} buildId={buildId}>
          <NotFoundView />
        </SiteChrome>
      </Providers>
    </NextIntlClientProvider>
  );
}
