'use client';

import { Accessibility } from 'lucide-react';
import type { BuyerSeatMapAppearance } from './buyer-seat-map';

/* The legend's tiles, painted as the map paints the seats (see SEAT_MAP_LOOK). */
const LEGEND_LOOK = {
  classic: {
    list: 'flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-border pt-3 text-caption text-text-secondary',
    available: 'border-border-input bg-background-surface',
    selected: 'border-action-primary bg-action-primary',
    sold: 'border-transparent bg-background-subtle',
    held: 'border-dashed border-border-strong bg-background-canvas',
  },
  stage: {
    list: 'flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-brand-line pt-4 text-brand-meta text-brand-ink-2',
    available: 'border-brand-ink-3 bg-transparent',
    selected: 'border-brand-marigold bg-brand-marigold',
    sold: 'border-transparent bg-brand-sunken',
    held: 'border-dashed border-brand-line-strong bg-transparent',
  },
} as const;

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
  appearance = 'classic',
}: {
  hasSold: boolean;
  hasHeld: boolean;
  hasAccessible: boolean;
  labels?: BuyerSeatLegendLabels;
  /** `stage` on the storefront's brand layer; `classic` (default) everywhere else. */
  appearance?: BuyerSeatMapAppearance;
}) {
  const look = LEGEND_LOOK[appearance];
  const tile = 'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.25rem] border';

  return (
    <ul className={look.list}>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className={`${tile} ${look.available}`} />
        {labels.available}
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className={`${tile} ${look.selected}`} />
        {labels.selected}
      </li>
      {hasSold ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={`${tile} ${look.sold}`} />
          {labels.sold}
        </li>
      ) : null}
      {/*
        Held and blocked seats share a mark: to a buyer both are "not now", and a legend entry
        for a state nobody can act on differently would only add reading.
      */}
      {hasHeld ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={`${tile} ${look.held}`} />
          {labels.held}
        </li>
      ) : null}
      {/* Only when the room has one: a key for a mark nobody will find teaches them to look for it. */}
      {hasAccessible ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={`${tile} ${look.available}`}>
            <Accessibility className="h-3 w-3" />
          </span>
          {labels.accessibleLegend}
        </li>
      ) : null}
    </ul>
  );
}
