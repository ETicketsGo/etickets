'use client';

import { useTranslations } from 'next-intl';
import { VenueMap, type VenueMapProps } from '@eticketsgo/web-kit';

export type StoreVenueMapProps = Omit<VenueMapProps, 'labels' | 'appearance'>;

/**
 * The venue overview in the buyer's language.
 *
 * Like `SeatMap`, the map itself lives in web-kit so the organizer's preview draws the very
 * component a buyer uses; this wrapper only supplies the translated words and the storefront's
 * look for the zoom buttons. Before it, a French buyer met an English map.
 */
export function StoreVenueMap(props: StoreVenueMapProps) {
  const s = useTranslations('storefront.seats');
  return (
    <VenueMap
      appearance="stage"
      {...props}
      labels={{
        zoomIn: s('venueZoomIn'),
        zoomOut: s('venueZoomOut'),
        zoomReset: s('venueZoomReset'),
        zoomHint: s('venueZoomHint'),
        // Buyers never move blocks; the editor's hint is never shown here.
        moveHint: '',
        mapLabel: (focal) => s('venueMapAria', { focal: focal.toLowerCase() }),
        soldOut: s('soldOut'),
        almostFull: s('venueAlmostFull'),
        standing: s('venueStanding'),
        keyAlmostFull: s('venueKeyAlmostFull'),
        keySoldOut: s('venueKeySoldOut'),
        listLead: s('venueListLead'),
        priceFrom: (price) => s('venuePriceFrom', { price }),
        unplacedLead: s('venueUnplacedLead'),
        describe: ({ name, soldOut, available, total, standing, price }) =>
          soldOut
            ? s('venueBlockSoldOut', { name })
            : price
              ? s(standing ? 'venueBlockStandingFrom' : 'venueBlockAvailableFrom', {
                  name,
                  available,
                  total,
                  price,
                })
              : s(standing ? 'venueBlockStanding' : 'venueBlockAvailable', {
                  name,
                  available,
                  total,
                }),
      }}
    />
  );
}
