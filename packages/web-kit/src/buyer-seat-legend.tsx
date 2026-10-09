'use client';

import { Accessibility } from 'lucide-react';

/** The words the legend uses. See `BuyerSeatMapLabels` for why they are passed in. */
export interface BuyerSeatLegendLabels {
  available: string;
  selected: string;
  sold: string;
  held: string;
  accessibleLegend: string;
}

export const BUYER_SEAT_LEGEND_LABELS_EN: BuyerSeatLegendLabels = {
  available: 'Available',
  selected: 'Selected',
  sold: 'Sold',
  held: 'Held',
  accessibleLegend: 'Wheelchair space or companion seat',
};

/**
 * What the tiles mean — drawn exactly as the seats are, so the legend is a key and not a second
 * vocabulary. Each state differs by shape (outline, fill, dashed edge, a number or none), so
 * none depends on colour alone.
 *
 * Prices are on the block headings above the map rather than here: comparing prices is done
 * while looking at the seats.
 */
export function BuyerSeatLegend({
  hasSold,
  hasHeld,
  hasAccessible,
  labels = BUYER_SEAT_LEGEND_LABELS_EN,
}: {
  hasSold: boolean;
  hasHeld: boolean;
  hasAccessible: boolean;
  labels?: BuyerSeatLegendLabels;
}) {
  const tile = 'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.25rem] border';

  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-border pt-3 text-caption text-text-secondary">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className={`${tile} border-border-input bg-background-surface`} />
        {labels.available}
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className={`${tile} border-action-primary bg-action-primary`} />
        {labels.selected}
      </li>
      {hasSold ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={`${tile} border-transparent bg-background-subtle`} />
          {labels.sold}
        </li>
      ) : null}
      {/*
        Held and blocked seats share a mark: to a buyer both are "not now", and a legend entry
        for a state nobody can act on differently would only add reading.
      */}
      {hasHeld ? (
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`${tile} border-dashed border-border-strong bg-background-canvas`}
          />
          {labels.held}
        </li>
      ) : null}
      {/* Only when the room has one: a key for a mark nobody will find teaches them to look for it. */}
      {hasAccessible ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={`${tile} border-border-input bg-background-surface`}>
            <Accessibility className="h-3 w-3" />
          </span>
          {labels.accessibleLegend}
        </li>
      ) : null}
    </ul>
  );
}
