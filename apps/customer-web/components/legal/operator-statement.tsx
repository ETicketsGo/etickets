'use client';

import { Suspense, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { publicLegalEntity } from '@eticketsgo/shared-types';
import { SELECTED_MARKET_COOKIE, useCity } from '@eticketsgo/web-kit';
import { usePathname } from '@/i18n/navigation';
import { footerRights, operatorMessage } from '@/lib/legal-entity';

/**
 * The market the reader selected, for naming a company: the country of a city they chose,
 * or null. Never the network's guess (see `CityPreference.selectedCountry`).
 */
export function useSelectedMarket(): string | null {
  return useCity().selectedCountry ?? null;
}

/**
 * "ETicketsGo is operated in India by ...", in the reader's language.
 *
 * `market` is the country whose company to name: a page passes the reader's selected market,
 * checkout passes the country of the company its currency is paid to. Null names both.
 */
export function OperatorStatement({
  market,
  className,
  testId = 'operator-statement',
}: {
  market: string | null | undefined;
  className?: string;
  testId?: string;
}) {
  const t = useTranslations('common.legalEntity');
  const message = operatorMessage(publicLegalEntity(market));
  return (
    <p data-testid={testId} className={className}>
      {t(message.key, message.values)}
    </p>
  );
}

/**
 * The legal pages whose body names a company from `resolveSelectedMarket` (lib/market.ts):
 * an explicit `?country=`, then the `etg_selected_market` cookie, then nobody.
 */
const LEGAL_PAGES = new Set(['/terms', '/privacy', '/refunds', '/cookies', '/sms']);

function readSelectedMarketCookie(): string | null {
  try {
    const prefix = `${SELECTED_MARKET_COOKIE}=`;
    const entry = document.cookie
      .split('; ')
      .find((c) => c.startsWith(prefix) && c.length > prefix.length);
    return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
  } catch {
    return null;
  }
}

const noSubscription = () => () => {};

/**
 * The market the footer names a company for.
 *
 * On a legal page it is resolved the way the page body resolves it, so the two never disagree:
 * `/terms?country=IN` named the Indian company in the body and neither in the footer, because
 * the footer read only the city choice. Order: explicit `?country=`, the `etg_selected_market`
 * cookie, the city choice, then null (both companies). Never `etg_market`, which can hold the
 * network's guess. Everywhere else it is the city choice, as before.
 */
function useFooterMarket(chosen: string | null): string | null {
  const pathname = usePathname();
  const params = useSearchParams();
  // No cookie on the server render: it hydrates as the city choice, then reads the cookie.
  const cookie = useSyncExternalStore(noSubscription, readSelectedMarketCookie, () => null);
  if (!LEGAL_PAGES.has(pathname)) return chosen;
  const asked = params?.get('country')?.trim();
  return asked || cookie || chosen;
}

function FooterLines({ market }: { market: string | null }) {
  const f = useTranslations('common.footer');
  const rights = footerRights(market, new Date().getFullYear());
  return (
    <div className="space-y-1">
      {/*
        The year is read at render rather than typed: a literal is wrong on 1 January. The
        company is read from the entity registry for the market the reader chose, so it
        cannot drift from the legal pages; with no market the line names no company and the
        operator line under it names both.
      */}
      <p data-testid="footer-rights">{f(rights.key, rights.values)}</p>
      <OperatorStatement market={market} testId="footer-operator" />
    </div>
  );
}

function FooterLinesForPage({ chosen }: { chosen: string | null }) {
  return <FooterLines market={useFooterMarket(chosen)} />;
}

/** The footer's copyright and operator lines, for the selected market. */
export function FooterLegalLines() {
  const chosen = useSelectedMarket();
  // `useSearchParams` needs a Suspense boundary on statically rendered pages; until the URL
  // is known the lines follow the city choice, which is what every non-legal page shows.
  return (
    <Suspense fallback={<FooterLines market={chosen} />}>
      <FooterLinesForPage chosen={chosen} />
    </Suspense>
  );
}
