'use client';

import { useTranslations } from 'next-intl';
import { publicLegalEntity } from '@eticketsgo/shared-types';
import { useCity } from '@eticketsgo/web-kit';
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

/** The footer's copyright and operator lines, for the selected market. */
export function FooterLegalLines() {
  const f = useTranslations('common.footer');
  const market = useSelectedMarket();
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
