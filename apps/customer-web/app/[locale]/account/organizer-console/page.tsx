'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { api as wk, consoleHandoffUrl, tokenStore } from '@eticketsgo/web-kit';
import { Link, useRouter } from '@/i18n/navigation';
import { ApiRequestError } from '@/lib/api';
import { ACCOUNT_PANEL, AccountPage } from '@/components/account-brand';
import { BRAND_LINK } from '@/components/booking-brand';
import { ORGANIZER_URL } from '@/lib/organizer-console';

/**
 * "Continue with your ETicketsGo account", seen from the organizer console's sign-in page.
 *
 * The console links here. Signed in on the storefront, this mints a one-time code for THIS
 * account and goes straight back to the console's `/handoff` with it in the URL fragment (see
 * lib/organizer-console.ts) - `location.replace`, so this page does not sit in history between
 * the two. Signed out, it asks for a storefront sign-in first and returns here.
 *
 * It only ever sends the browser to the configured console origin, never to an address taken
 * from the URL, so it cannot be used as an open redirect.
 */
export default function OrganizerConsoleHandoffPage() {
  const t = useTranslations('storefront.becomeOrganizer');
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!tokenStore.access) {
      router.replace('/login?next=/account/organizer-console');
      return;
    }
    wk.auth
      .createHandoff('organizer')
      .then(({ code }) => window.location.replace(consoleHandoffUrl(ORGANIZER_URL, code)))
      .catch((err: unknown) =>
        setError(err instanceof ApiRequestError ? err.message : t('emailFailed')),
      );
  }, [router, t]);

  return (
    <AccountPage width="narrow">
      <div className={`${ACCOUNT_PANEL} space-y-4 p-6 sm:p-8`}>
        {error ? (
          <>
            <p role="alert" data-testid="organizer-console-refused" className="text-brand-ui">
              {error}
            </p>
            <p className="flex flex-wrap gap-4 text-brand-meta">
              <Link href="/account/become-organizer" className={BRAND_LINK}>
                {t('consoleBecome')}
              </Link>
              <Link href="/account" className={BRAND_LINK}>
                {t('consoleBack')}
              </Link>
            </p>
          </>
        ) : (
          <p role="status" className="flex items-center gap-3 text-brand-ui text-brand-ink-2">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            {t('consoleOpening')}
          </p>
        )}
      </div>
    </AccountPage>
  );
}
