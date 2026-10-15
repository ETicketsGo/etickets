'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { VenueFocalPoint, VenuePoint, VenueSectionSummary } from './api';
import { isDarkFill, readableTextOn } from './colour-contrast';

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
 * ── COLOUR IS THE TICKET CATEGORY ──────────────────────────────────────────────────
 * Each block is filled with the colour of its ticket category (the one most of its seats are
 * in), the same colour the category has everywhere else. It used to be one colour for every
 * block - and once the redesign made the primary near-black, a dark grey slab - so Premium,
 * Standard and VIP areas looked identical and the names on them were dark on dark.
 *
 * Availability is the SECOND cue and never hides the first: an almost-full block keeps its
 * colour under diagonal stripes and says "Almost full"; a sold-out block, which cannot be
 * chosen, goes grey and says "Sold out". Words carry both, so neither depends on colour.
 * Text on a block is black or white, whichever reads better on that colour (always AA).
 */

const VIEWBOX = 1000;

/**
 * Below this rendered width, the map's labels are too small to read.
 *
 * Labels are sized in map units (20 of 1000), so they shrink with the map: on a 390px phone the
 * map is about 300px wide and a block's name and price render at about 6px. A buyer could tap a
 * block but could not read which block it was, or what it cost. Under this width the blocks are
 * also listed beneath the map, at a size people can read and tap.
 */
const NARROW_MAP_PX = 560;

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
  /**
   * The block whose seats are on screen next to the map, outlined so the customer can see where
   * they are while they choose seats - and choose another block without leaving the page.
   */
  activeSectionId?: string | null;
  /**
   * Whether a narrow map also lists its blocks as buttons. On by default, because a block too small
   * to tap must still be reachable; off where the same blocks are already a list elsewhere.
   */
  listWhenNarrow?: boolean;
  /**
   * Whether to show the availability key (available / almost full / sold out). Off in the layout
   * editor, where nothing is on sale and "sold out" would only confuse.
   */
  availabilityLegend?: boolean;
}

/** Where a block stands on the "any left?" scale. Three states, because three is readable. */
type Fill = 'plenty' | 'few' | 'none';

function fillFor(section: VenueSectionSummary): Fill {
  if (section.availableCount === 0) return 'none';
  // Under a tenth left is "few". Anything finer would be a distinction nobody acts on.
  return section.availableCount / Math.max(1, section.totalCount) < 0.1 ? 'few' : 'plenty';
}

/** A block whose API sent no category colour (an older API). Neutral, readable in both themes. */
const NEUTRAL_FILL = '#CBD5E1';
/** A sold-out block: it cannot be chosen, so it is not shown in its category colour either. */
const SOLD_OUT_FILL = '#E2E8F0';
const HEX = /^#[0-9a-f]{6}$/i;

/** The colour a block is drawn in, and the text colour that reads on it. */
function paintFor(section: VenueSectionSummary, fill: Fill): { fill: string; text: string } {
  const base =
    fill === 'none'
      ? SOLD_OUT_FILL
      : section.colorHex && HEX.test(section.colorHex)
        ? section.colorHex
        : NEUTRAL_FILL;
  return { fill: base, text: readableTextOn(base) };
}

export function VenueMap({
  focal,
  sections,
  onSelect,
  formatPrice,
  pendingSectionId,
  activeSectionId,
  listWhenNarrow = true,
  availabilityLegend = true,
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

  const svgRef = useRef<SVGSVGElement>(null);
  // Pattern ids must be unique per map: one page can show two maps.
  const uid = useId().replace(/:/g, '');
  /** The categories on the map, once each, for the key under it. */
  const categoryKey = useMemo(() => {
    const seen = new Map<string, string>();
    for (const sec of sections) {
      if (sec.categoryName && sec.colorHex && !seen.has(sec.categoryName)) {
        seen.set(sec.categoryName, sec.colorHex);
      }
    }
    return [...seen.entries()];
  }, [sections]);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width < NARROW_MAP_PX),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="space-y-3">
      <svg
        ref={svgRef}
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

        <defs>
          {/* Stripes for "almost full": light on a dark block, dark on a light one. */}
          {(['light', 'dark'] as const).map((tone) => (
            <pattern
              key={tone}
              id={`${uid}-few-${tone}`}
              width={18}
              height={18}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect
                width={7}
                height={18}
                fill={tone === 'light' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.35)'}
              />
            </pattern>
          ))}
          <pattern
            id={`${uid}-none`}
            width={14}
            height={14}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width={3} height={14} fill="rgba(71,85,105,0.45)" />
          </pattern>
        </defs>

        {/* The chosen block last, so its outline is drawn over its neighbours'. */}
        {[...drawable]
          .sort((a, b) => Number(a.id === activeSectionId) - Number(b.id === activeSectionId))
          .map((section) => {
            const fill = fillFor(section);
            const soldOut = fill === 'none';
            const standingZone = section.kind === 'ZONE';
            const paint = paintFor(section, fill);
            const chosen = activeSectionId === section.id || pendingSectionId === section.id;
            // With a block chosen, the others step back so the choice is unmistakable.
            const dimmed = !!activeSectionId && !chosen;
            const points = toPoints(section.shape as VenuePoint[]);
            const [cx, cy] =
              section.labelX !== null && section.labelY !== null
                ? [section.labelX, section.labelY]
                : centroidOf(section.shape as VenuePoint[]);
            const note = soldOut ? 'Sold out' : fill === 'few' ? 'Almost full' : null;
            const second = note
              ? note
              : standingZone
                ? 'STANDING'
                : section.priceMinorFrom !== null
                  ? formatPrice(section.priceMinorFrom)
                  : null;
            return (
              <g key={section.id} data-block={section.name} data-dimmed={dimmed || undefined}>
                <polygon
                  points={points}
                  fill={paint.fill}
                  /*
                    Only the FILL steps back. Dimming the whole block also faded its name below AA;
                    the label keeps full contrast on a halo of the block's full colour.
                  */
                  fillOpacity={dimmed ? 0.4 : 1}
                  strokeWidth={chosen ? 8 : 3}
                  strokeLinejoin="round"
                  className={`transition-all ${
                    chosen ? 'stroke-text-primary' : 'stroke-background-surface'
                  } ${soldOut ? 'cursor-not-allowed' : 'cursor-pointer hover:brightness-110'}`}
                  aria-pressed={
                    soldOut || standingZone || activeSectionId === undefined
                      ? undefined
                      : activeSectionId === section.id
                  }
                  onClick={soldOut || standingZone ? undefined : () => onSelect(section.id)}
                  /*
                    Keyboard reachability on an SVG shape needs all of this: a role, a
                    tabindex, and a key handler. Without it the entire venue is mouse-only,
                    which for a page whose only job is choosing a seat means the page has no
                    keyboard path at all.
                  */
                  role={soldOut || standingZone ? undefined : 'button'}
                  tabIndex={soldOut || standingZone ? undefined : 0}
                  aria-label={describe(section, formatPrice)}
                  onKeyDown={
                    soldOut || standingZone
                      ? undefined
                      : (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(section.id);
                          }
                        }
                  }
                />
                {fill !== 'plenty' ? (
                  <polygon
                    points={points}
                    aria-hidden
                    className="pointer-events-none"
                    opacity={dimmed ? 0.4 : 1}
                    fill={
                      soldOut
                        ? `url(#${uid}-none)`
                        : `url(#${uid}-few-${isDarkFill(paint.fill) ? 'light' : 'dark'})`
                    }
                  />
                ) : null}
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  fill={paint.text}
                  // A halo in the block's own colour, so stripes never run through the letters.
                  stroke={paint.fill}
                  strokeWidth={6}
                  paintOrder="stroke"
                  className="pointer-events-none text-[22px] font-bold"
                >
                  {section.name}
                </text>
                {second ? (
                  <text
                    x={cx}
                    y={cy + 24}
                    textAnchor="middle"
                    fill={paint.text}
                    // A halo in the block's own colour, so stripes never run through the letters.
                    stroke={paint.fill}
                    strokeWidth={6}
                    paintOrder="stroke"
                    className="pointer-events-none text-[18px] font-semibold"
                  >
                    {second}
                  </text>
                ) : null}
              </g>
            );
          })}
      </svg>

      {categoryKey.length > 0 || availabilityLegend ? (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-text-secondary"
          data-testid="venue-map-key"
        >
          {categoryKey.map(([name, hex]) => (
            <span key={name} className="flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-3 rounded-sm border border-border"
                style={{ backgroundColor: hex }}
                aria-hidden="true"
              />
              {name}
            </span>
          ))}
          {availabilityLegend ? (
            <>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-3 rounded-sm border border-border"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(45deg, rgba(0,0,0,0.45) 0 2px, transparent 2px 5px)',
                  }}
                  aria-hidden="true"
                />
                Striped: almost full
              </span>
              <LegendSwatch className="border border-border bg-[#E2E8F0]" label="Grey: sold out" />
            </>
          ) : null}
        </div>
      ) : null}

      {listWhenNarrow && narrow && drawable.length > 0 ? (
        <div data-testid="venue-map-list" className="space-y-2">
          <p className="text-caption text-text-muted">Or choose a block from the list:</p>
          <ul className="grid gap-2">
            {drawable.map((section) => {
              const soldOut = fillFor(section) === 'none';
              const standingZone = section.kind === 'ZONE';
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    disabled={soldOut || standingZone}
                    onClick={() => onSelect(section.id)}
                    aria-pressed={
                      activeSectionId === undefined ? undefined : activeSectionId === section.id
                    }
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-background-subtle disabled:opacity-50 ${
                      activeSectionId === section.id
                        ? 'border-action-primary bg-tint-primary'
                        : 'border-border'
                    }`}
                  >
                    <span className="font-medium">{section.name}</span>
                    <span className="text-text-secondary">
                      {soldOut
                        ? 'Sold out'
                        : standingZone
                          ? 'Standing'
                          : section.priceMinorFrom !== null
                            ? `from ${formatPrice(section.priceMinorFrom)}`
                            : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {unplaced.length > 0 ? (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-caption text-text-muted">Not on the map yet — still bookable:</p>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((section) => (
              <button
                key={section.id}
                type="button"
                disabled={section.availableCount === 0 || section.kind === 'ZONE'}
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
  const unit = section.kind === 'ZONE' ? 'places' : 'seats';
  return `${section.name}, ${section.availableCount} of ${section.totalCount} ${unit} available${price}`;
}

function centroidOf(points: VenuePoint[]): VenuePoint {
  const sum = points.reduce<[number, number]>((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
  return [Math.round(sum[0] / points.length), Math.round(sum[1] / points.length)];
}
