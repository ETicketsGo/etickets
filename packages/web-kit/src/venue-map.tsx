'use client';

import { useMemo } from 'react';
import type { VenueFocalPoint, VenuePoint, VenueSectionSummary } from './api';

/**
 * The venue seen from above: blocks around a stage, a pitch or a screen.
 *
 * ── WHY A MAP AND NOT A LONGER LIST ────────────────────────────────────────────────
 * For a cinema, a list of rows is the right answer and this component is never used. For
 * anything bigger it stops working, and not gradually: "Upper 214" means nothing to
 * somebody who has never been to the venue, and a dropdown of sixty such names is not a
 * choice anybody can make. What people actually decide is *where in the room* they want to
 * sit and what that costs — which is a picture.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
 * No pan, no pinch-zoom, no seat-level rendering. The overview's whole job is to get the
 * customer into one block; the seats then render as an ordinary grid, which is legible on a
 * phone in a way three thousand four-pixel dots never are. Building a zoomable canvas here
 * would be a lot of work to arrive somewhere worse.
 *
 * ── COLOUR MEANS ONE THING ─────────────────────────────────────────────────────────
 * Availability, not price. A map that encodes price in colour and availability in opacity
 * asks the customer to hold two scales at once, and the question they are answering first
 * is "can I even sit there". Price is written on the block, in words.
 */

const VIEWBOX = 1000;

/** SVG needs "x,y x,y"; the API sends [[x, y], …]. */
const toPoints = (shape: VenuePoint[]) => shape.map(([x, y]) => `${x},${y}`).join(' ');

export interface VenueMapProps {
  focal: VenueFocalPoint;
  sections: VenueSectionSummary[];
  onSelect: (sectionId: string) => void;
  /** Renders a price as text. Injected so the map does not need to know about currency. */
  formatPrice: (minor: number) => string;
  /** Highlighted while the seats for it are loading, so a tap feels like it did something. */
  pendingSectionId?: string | null;
}

/** Where a block stands on the "any left?" scale. Three states, because three is readable. */
type Fill = 'plenty' | 'few' | 'none';

function fillFor(section: VenueSectionSummary): Fill {
  if (section.availableCount === 0) return 'none';
  // Under a tenth left is "few". Anything finer would be a distinction nobody acts on.
  return section.availableCount / Math.max(1, section.totalCount) < 0.1 ? 'few' : 'plenty';
}

const FILL_CLASS: Record<Fill, string> = {
  plenty: 'fill-action-primary/70 stroke-action-primary hover:fill-action-primary',
  few: 'fill-status-warning/60 stroke-status-warning hover:fill-status-warning/80',
  // Not merely dimmed: a sold-out block is not clickable, and must not invite a tap.
  none: 'fill-text-muted/20 stroke-text-muted/40',
};

export function VenueMap({
  focal,
  sections,
  onSelect,
  formatPrice,
  pendingSectionId,
}: VenueMapProps) {
  /*
    Sections with no outline still have to be reachable.

    A layout can carry a block whose geometry was never set — an older venue, a hand-made
    section, a template that grew a block after the map was drawn. Dropping it from the map
    would silently make its seats unsellable, so it is listed underneath instead. Quietly
    losing inventory is the worst possible failure here.
  */
  const { drawable, unplaced } = useMemo(
    () => ({
      drawable: sections.filter((s) => Array.isArray(s.shape) && s.shape.length >= 3),
      unplaced: sections.filter((s) => !Array.isArray(s.shape) || s.shape.length < 3),
    }),
    [sections],
  );

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        className="w-full rounded-xl border border-border bg-background-subtle"
        role="group"
        aria-label={`Venue map. Choose where to sit, facing the ${focal.label.toLowerCase()}.`}
      >
        {focal.shape && focal.shape.length >= 3 ? (
          <g>
            <polygon
              points={toPoints(focal.shape)}
              className="fill-text-primary/85 stroke-text-primary"
              strokeWidth={2}
            />
            <text
              x={centroidOf(focal.shape)[0]}
              y={centroidOf(focal.shape)[1] + 6}
              textAnchor="middle"
              className="fill-background-surface text-[22px] font-semibold uppercase tracking-widest"
            >
              {focal.label}
            </text>
          </g>
        ) : null}

        {drawable.map((section) => {
          const fill = fillFor(section);
          const soldOut = fill === 'none';
          const [cx, cy] =
            section.labelX !== null && section.labelY !== null
              ? [section.labelX, section.labelY]
              : centroidOf(section.shape as VenuePoint[]);
          return (
            <g key={section.id}>
              <polygon
                points={toPoints(section.shape as VenuePoint[])}
                strokeWidth={pendingSectionId === section.id ? 6 : 2}
                className={`${FILL_CLASS[fill]} transition-all ${
                  soldOut ? 'cursor-not-allowed' : 'cursor-pointer'
                }`}
                onClick={soldOut ? undefined : () => onSelect(section.id)}
                /*
                  Keyboard reachability on an SVG shape needs all of this: a role, a
                  tabindex, and a key handler. Without it the entire venue is mouse-only,
                  which for a page whose only job is choosing a seat means the page has no
                  keyboard path at all.
                */
                role={soldOut ? undefined : 'button'}
                tabIndex={soldOut ? undefined : 0}
                aria-label={describe(section, formatPrice)}
                onKeyDown={
                  soldOut
                    ? undefined
                    : (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect(section.id);
                        }
                      }
                }
              />
              <text
                x={cx}
                y={cy}
                textAnchor="middle"
                className="pointer-events-none fill-text-primary text-[20px] font-semibold"
              >
                {section.name}
              </text>
              {section.priceMinorFrom !== null && !soldOut ? (
                <text
                  x={cx}
                  y={cy + 22}
                  textAnchor="middle"
                  className="pointer-events-none fill-text-primary/80 text-[16px]"
                >
                  {formatPrice(section.priceMinorFrom)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-text-secondary">
        <LegendSwatch className="bg-action-primary/70" label="Seats available" />
        <LegendSwatch className="bg-status-warning/60" label="Almost full" />
        <LegendSwatch className="bg-text-muted/20" label="Sold out" />
      </div>

      {unplaced.length > 0 ? (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-caption text-text-muted">Not on the map yet — still bookable:</p>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((section) => (
              <button
                key={section.id}
                type="button"
                disabled={section.availableCount === 0}
                onClick={() => onSelect(section.id)}
                className="rounded-md border border-border px-2.5 py-1 text-caption text-text-primary transition-colors hover:bg-background-subtle disabled:opacity-50"
              >
                {section.name}
                {section.priceMinorFrom !== null
                  ? ` · from ${formatPrice(section.priceMinorFrom)}`
                  : ''}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 rounded-sm ${className}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/** What a screen reader hears, which is the same three facts the picture shows. */
function describe(section: VenueSectionSummary, formatPrice: (minor: number) => string): string {
  if (section.availableCount === 0) return `${section.name}, sold out`;
  const price =
    section.priceMinorFrom !== null ? `, from ${formatPrice(section.priceMinorFrom)}` : '';
  return `${section.name}, ${section.availableCount} of ${section.totalCount} seats available${price}`;
}

function centroidOf(points: VenuePoint[]): VenuePoint {
  const sum = points.reduce<[number, number]>((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
  return [Math.round(sum[0] / points.length), Math.round(sum[1] / points.length)];
}
