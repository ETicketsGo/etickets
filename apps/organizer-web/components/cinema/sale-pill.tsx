'use client';

import { SellingPill, StatusPill } from '@eticketsgo/web-kit';
import { pillSellingOf, type SaleVerdict } from './cinema-model';

/**
 * The server's unified sale state as the design system's selling pill.
 *
 * "Selling" | "Partly selling: <reason>" | "Not selling: <reason>" - the same three sentences
 * and the same colours as every other organizer screen. While there is no server answer the
 * pill says so in neutral words ("Checking sale status", "Sale status unavailable"); it never
 * falls back to "Selling".
 *
 * `wrap` lets the reason run onto a second line where the pill sits in a narrow column and the
 * reason is the useful half - the design-system pill truncates, with the full words in `title`.
 */
export function SalePill({
  verdict,
  size = 'md',
  wrap = false,
}: {
  verdict: Pick<SaleVerdict, 'state' | 'label'>;
  size?: 'sm' | 'md';
  wrap?: boolean;
}) {
  const s = pillSellingOf(verdict);
  const pill = s ? (
    <SellingPill {...s} size={size} />
  ) : (
    <StatusPill tone="neutral" size={size}>
      {verdict.label}
    </StatusPill>
  );
  if (!wrap) return pill;
  return (
    <span className="inline-flex max-w-full [&>span]:h-auto [&>span]:whitespace-normal [&>span>span:last-child]:whitespace-normal [&>span>span:last-child]:[overflow-wrap:anywhere]">
      {pill}
    </span>
  );
}
