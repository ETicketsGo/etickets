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
 * The design-system pill wraps rather than truncating, so the reason is always on screen. In a
 * dense cell (a week column), `layout="stacked"` puts the state word in the pill and the reason
 * as plain text under it, instead of a two-line block of tint.
 */
export function SalePill({
  verdict,
  size = 'md',
  layout = 'pill',
}: {
  verdict: Pick<SaleVerdict, 'state' | 'label'>;
  size?: 'sm' | 'md';
  layout?: 'pill' | 'stacked';
}) {
  const s = pillSellingOf(verdict);
  return s ? (
    <SellingPill {...s} size={size} layout={layout} />
  ) : (
    <StatusPill tone="neutral" size={size}>
      {verdict.label}
    </StatusPill>
  );
}
