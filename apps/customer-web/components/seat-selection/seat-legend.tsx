'use client';

import { useTranslations } from 'next-intl';
import { BuyerSeatLegend } from '@eticketsgo/web-kit';

/**
 * The seat legend, in the buyer's language.
 *
 * The drawing lives in web-kit (`BuyerSeatLegend`) so the organizer's "preview as buyer" shows
 * the same key the buyer reads. This wrapper only supplies the translated words.
 */
export function SeatLegend({
  hasSold,
  hasHeld,
  hasAccessible,
}: {
  hasSold: boolean;
  hasHeld: boolean;
  hasAccessible: boolean;
}) {
  const s = useTranslations('storefront.seats');
  return (
    <BuyerSeatLegend
      hasSold={hasSold}
      hasHeld={hasHeld}
      hasAccessible={hasAccessible}
      labels={{
        available: s('available'),
        selected: s('selected'),
        sold: s('sold'),
        held: s('held'),
        accessibleLegend: s('accessibleLegend'),
      }}
    />
  );
}
