'use client';

import { useTranslations } from 'next-intl';
import { BuyerSeatMap, type BuyerSeatMapProps } from '@eticketsgo/web-kit';

export type SeatMapProps = Omit<BuyerSeatMapProps, 'labels'>;

/**
 * The room, seat by seat, in the buyer's language.
 *
 * The map itself is `BuyerSeatMap` in web-kit, moved there unchanged so the organizer's
 * "preview as buyer" renders the very component a buyer uses - a second, look-alike drawing
 * would be a preview of something else. This wrapper only supplies the translated words.
 */
export function SeatMap(props: SeatMapProps) {
  const s = useTranslations('storefront.seats');
  return (
    <BuyerSeatMap
      {...props}
      labels={{
        screenThisWay: s('screenThisWay'),
        stageThisWay: s('stageThisWay'),
        fieldThisWay: s('fieldThisWay'),
        zoomIn: s('zoomIn'),
        zoomOut: s('zoomOut'),
        zoomReset: s('zoomReset'),
        mapLabel: s('mapLabel'),
        mapInstructions: s('mapInstructions'),
        seatName: (name) => s('seatName', { name }),
        priceFrom: (price) => s('priceFrom', { price }),
      }}
    />
  );
}
