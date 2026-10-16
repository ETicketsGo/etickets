'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Minus, Plus, ScanLine } from 'lucide-react';
import type { VenueFocalPoint, VenuePoint, VenueSectionSummary } from './api';
import { SEAT_MAP_LOOK, type BuyerSeatMapAppearance } from './buyer-seat-map';
import { isDarkFill, readableTextOn } from './colour-contrast';
import {
  FULL_CANVAS,
  MAX_ZOOM,
  ZOOM_STEP,
  clampView,
  frameAround,
  homeView,
  panBy,
  pointAt,
  viewBoxOf,
  zoomTo,
  type MapBox,
  type MapView,
} from './venue-map-view';

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
 * No seat-level rendering. The overview's whole job is to get the customer into one block; the
 * seats then render as an ordinary grid, which is legible on a phone in a way three thousand
 * four-pixel dots never are.
 *
 * ── IT DOES ZOOM, BECAUSE A PHONE COULD NOT READ IT ─────────────────────────────────────
 * Labels are drawn in map units, so they shrink with the map: on a 390px phone a block's name
 * was 7-9px and its price about 6px. The map now frames the venue rather than the empty canvas
 * around it, and zooms (buttons, pinch, ctrl + wheel) with one finger to move around; the
 * labels grow with the zoom. The list under a narrow map stays, for anyone who would rather
 * not zoom at all. See venue-map-view.ts for the arithmetic.
 *
 * ── IN THE LAYOUT EDITOR, BLOCKS MOVE ───────────────────────────────────────────────
 * Given `onMoveBlock`, a block can be dragged (or moved with the arrow keys once chosen); the
 * map only reports how far, in map units, and the editor decides what that does to the layout.
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
  /**
   * What the map frames: `content` (default) fits the blocks and the stage, so they are drawn as
   * large as the box allows; `canvas` shows the whole 0-1000 square, for the layout editor, where
   * a block may be moved into empty space.
   */
  frame?: 'content' | 'canvas';
  /**
   * Lets the person move blocks: dragging a block, or the arrow keys on a chosen block, reports
   * how far in map units. Absent (the buyer's map), blocks do not move and a drag pans instead.
   */
  onMoveBlock?: (sectionId: string, dx: number, dy: number) => void;
  /** The words the map uses. The storefront passes its translations; the default is English. */
  labels?: VenueMapLabels;
  /** `stage` on the storefront's brand layer, for the zoom buttons; `classic` everywhere else. */
  appearance?: BuyerSeatMapAppearance;
}

/**
 * Every word the map shows or speaks, passed in for the same reason as the seat map's: web-kit
 * has no translation runtime, and a French buyer must not meet an English map.
 */
export interface VenueMapLabels {
  zoomIn: string;
  zoomOut: string;
  zoomReset: string;
  /** Under the zoom buttons: how to zoom and move around. */
  zoomHint: string;
  /** In the editor: how to move a block. */
  moveHint: string;
  mapLabel: (focal: string) => string;
  soldOut: string;
  almostFull: string;
  /** Written on a standing zone. */
  standing: string;
  keyAlmostFull: string;
  keySoldOut: string;
  listLead: string;
  priceFrom: (price: string) => string;
  unplacedLead: string;
  /** What a screen reader hears for a block. `price` is already formatted, or null. */
  describe: (block: {
    name: string;
    soldOut: boolean;
    available: number;
    total: number;
    standing: boolean;
    price: string | null;
  }) => string;
}

export const VENUE_MAP_LABELS_EN: VenueMapLabels = {
  // Not "Zoom in": the seat grid on the same page has those, and two buttons with one name are
  // two buttons a screen reader cannot tell apart.
  zoomIn: 'Enlarge the map',
  zoomOut: 'Make the map smaller',
  zoomReset: 'Show the whole map',
  zoomHint: 'Pinch or use + to zoom. Drag to move around.',
  moveHint: 'Drag a block to move it, or choose it and use the arrow keys.',
  mapLabel: (focal) => `Venue map. Choose where to sit, facing the ${focal.toLowerCase()}.`,
  soldOut: 'Sold out',
  almostFull: 'Almost full',
  standing: 'STANDING',
  keyAlmostFull: 'Striped: almost full',
  keySoldOut: 'Grey: sold out',
  listLead: 'Or choose a block from the list:',
  priceFrom: (price) => `from ${price}`,
  unplacedLead: 'Not on the map yet - still bookable:',
  describe: ({ name, soldOut, available, total, standing, price }) =>
    soldOut
      ? `${name}, sold out`
      : `${name}, ${available} of ${total} ${standing ? 'places' : 'seats'} available${
          price ? `, from ${price}` : ''
        }`,
};

/** How far one arrow key moves a chosen block, in map units (a hundredth of the map). */
const KEY_STEP = 10;
/** Movement (px) before a press becomes a drag; less is a tap that chooses the block. */
const DRAG_PX = 6;

/** What the pointers on the map are doing. */
type Gesture =
  | { kind: 'press'; x: number; y: number; blockId: string | null; view: MapView }
  | { kind: 'drag'; x: number; y: number; blockId: string; unitsPerPx: number }
  | { kind: 'pan'; x: number; y: number; view: MapView }
  | { kind: 'pinch'; distance: number; view: MapView; anchor: [number, number] };

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
  frame = 'content',
  onMoveBlock,
  labels = VENUE_MAP_LABELS_EN,
  appearance = 'classic',
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

  // -- What is on screen ------------------------------------------------------------------
  const frameBox: MapBox = useMemo(
    () =>
      frame === 'canvas'
        ? FULL_CANVAS
        : frameAround([
            ...drawable.map((s) => s.shape as VenuePoint[]),
            ...(focal.shape && focal.shape.length >= 3 ? [focal.shape] : []),
          ]),
    [frame, drawable, focal.shape],
  );
  const frameRef = useRef(frameBox);
  frameRef.current = frameBox;
  // Null is "the whole venue"; it stays that way as blocks change, rather than a stale zoom.
  const [view, setView] = useState<MapView | null>(null);
  const current = view ? clampView(frameBox, view) : homeView(frameBox);
  const box = viewBoxOf(frameBox, current);
  const zoomed = current.scale > 1.001;

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  // A drag or a pinch ends in a click on whatever is under the finger; that click is not a choice.
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);

  const blockIdOf = (target: EventTarget | null) =>
    target instanceof Element
      ? (target.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null)
      : null;

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      // A fresh press: whatever the last gesture left behind no longer applies.
      suppressClick.current = false;
      gesture.current = {
        kind: 'press',
        x: e.clientX,
        y: e.clientY,
        blockId: onMoveBlock ? blockIdOf(e.target) : null,
        view: current,
      };
    } else if (pointers.current.size === 2) {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return;
      const [a, b] = [...pointers.current.values()];
      setDrag(null);
      suppressClick.current = true;
      gesture.current = {
        kind: 'pinch',
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        view: current,
        anchor: pointAt(
          frameBox,
          current,
          (a.x + b.x) / 2 - r.left,
          (a.y + b.y) / 2 - r.top,
          r.width,
        ),
      };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = svgRef.current?.getBoundingClientRect();
    const g = gesture.current;
    if (!g || !r) return;
    if (g.kind === 'press') {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_PX) return;
      if (g.blockId) {
        gesture.current = {
          kind: 'drag',
          x: g.x,
          y: g.y,
          blockId: g.blockId,
          unitsPerPx: viewBoxOf(frameBox, g.view).w / r.width,
        };
      } else if (g.view.scale > 1.001) {
        gesture.current = { kind: 'pan', x: g.x, y: g.y, view: g.view };
      } else {
        // Unzoomed, a drag over the map is the page scrolling, never the map's business.
        gesture.current = null;
        return;
      }
      // Touch is captured by the browser already; a mouse needs it to keep dragging off the map.
      if (e.pointerType === 'mouse') svgRef.current?.setPointerCapture?.(e.pointerId);
      suppressClick.current = true;
    }
    const now = gesture.current;
    if (now?.kind === 'drag') {
      setDrag({
        id: now.blockId,
        dx: (e.clientX - now.x) * now.unitsPerPx,
        dy: (e.clientY - now.y) * now.unitsPerPx,
      });
    } else if (now?.kind === 'pan') {
      setView(panBy(frameBox, now.view, e.clientX - now.x, e.clientY - now.y, r.width));
    } else if (now?.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const at: [number, number] = [
        ((a.x + b.x) / 2 - r.left) / r.width,
        ((a.y + b.y) / 2 - r.top) / r.height,
      ];
      const scale = (now.view.scale * Math.hypot(a.x - b.x, a.y - b.y)) / now.distance;
      setView(zoomTo(frameBox, scale, now.anchor, at));
    }
  };

  const onPointerEnd = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (g?.kind === 'drag') {
      setDrag(null);
      if (e.type === 'pointerup' && onMoveBlock) {
        const dx = Math.round((e.clientX - g.x) * g.unitsPerPx);
        const dy = Math.round((e.clientY - g.y) * g.unitsPerPx);
        if (dx !== 0 || dy !== 0) onMoveBlock(g.blockId, dx, dy);
      }
    }
    // After a pinch the finger still down starts nothing until it is lifted, or the map would jump.
    if (pointers.current.size === 0 || g?.kind === 'pinch') gesture.current = null;
  };

  // Ctrl + wheel is how a trackpad pinches. A plain wheel stays the page's scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        const f = frameRef.current;
        const cur = v ? clampView(f, v) : homeView(f);
        const anchor = pointAt(f, cur, e.clientX - r.left, e.clientY - r.top, r.width);
        return zoomTo(f, cur.scale * Math.exp(-e.deltaY / 200), anchor, [
          (e.clientX - r.left) / r.width,
          (e.clientY - r.top) / r.height,
        ]);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** Zoom by a step. Zooming in goes towards the chosen block, if there is one. */
  const zoomBy = (factor: number) => {
    const target =
      factor > 1 ? drawable.find((sec) => sec.id === (activeSectionId ?? pendingSectionId)) : null;
    const anchor: [number, number] = target
      ? target.labelX !== null && target.labelY !== null
        ? [target.labelX, target.labelY]
        : centroidOf(target.shape as VenuePoint[])
      : [current.cx, current.cy];
    setView(zoomTo(frameBox, current.scale * factor, anchor));
  };

  const look = SEAT_MAP_LOOK[appearance];
  const hint = onMoveBlock ? labels.moveHint : narrow || zoomed ? labels.zoomHint : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-caption text-text-muted">{hint}</p>
        <div className="flex shrink-0 items-center gap-1" data-testid="venue-map-zoom">
          {(
            [
              {
                label: labels.zoomOut,
                icon: Minus,
                disabled: !zoomed,
                run: () => zoomBy(1 / ZOOM_STEP),
              },
              {
                label: labels.zoomReset,
                icon: ScanLine,
                disabled: !zoomed,
                run: () => setView(null),
              },
              {
                label: labels.zoomIn,
                icon: Plus,
                disabled: current.scale >= MAX_ZOOM - 0.001,
                run: () => zoomBy(ZOOM_STEP),
              },
            ] as const
          ).map(({ label, icon: Icon, disabled, run }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={run}
              className={look.zoom}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          ))}
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${round1(box.x)} ${round1(box.y)} ${round1(box.w)} ${round1(box.h)}`}
        className="w-full select-none rounded-xl border border-border bg-background-subtle"
        // The box keeps the venue's proportions at every zoom: zooming changes what is inside it.
        style={{
          aspectRatio: `${frameBox.w} / ${frameBox.h}`,
          // Zoomed, one finger moves the map; unzoomed it scrolls the page, as it always did.
          touchAction: zoomed ? 'none' : 'pan-y',
        }}
        data-zoom={current.scale.toFixed(2)}
        role="group"
        aria-label={labels.mapLabel(focal.label)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={(e) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
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
            const note = soldOut ? labels.soldOut : fill === 'few' ? labels.almostFull : null;
            const second = note
              ? note
              : standingZone
                ? labels.standing
                : section.priceMinorFrom !== null
                  ? formatPrice(section.priceMinorFrom)
                  : null;
            const movable = !!onMoveBlock && !standingZone;
            const moving = drag?.id === section.id ? drag : null;
            return (
              <g
                key={section.id}
                data-block={section.name}
                data-dimmed={dimmed || undefined}
                transform={
                  moving ? `translate(${round1(moving.dx)} ${round1(moving.dy)})` : undefined
                }
              >
                <polygon
                  points={points}
                  data-section-id={section.id}
                  // A block that moves takes the finger itself, so dragging it never scrolls the page.
                  style={movable ? { touchAction: 'none' } : undefined}
                  fill={paint.fill}
                  /*
                    Only the FILL steps back. Dimming the whole block also faded its name below AA;
                    the label keeps full contrast on a halo of the block's full colour.
                  */
                  fillOpacity={dimmed ? 0.4 : 1}
                  strokeWidth={chosen ? 8 : 3}
                  strokeLinejoin="round"
                  className={`${moving ? '' : 'transition-all'} ${
                    chosen ? 'stroke-text-primary' : 'stroke-background-surface'
                  } ${
                    soldOut
                      ? 'cursor-not-allowed'
                      : movable
                        ? 'cursor-move hover:brightness-110'
                        : 'cursor-pointer hover:brightness-110'
                  }`}
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
                  aria-label={describe(section, formatPrice, labels)}
                  onKeyDown={
                    soldOut || standingZone
                      ? undefined
                      : (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(section.id);
                            return;
                          }
                          // In the editor the arrow keys move the chosen block, a step at a time.
                          const step = movable ? ARROW_STEPS[e.key] : undefined;
                          if (step && onMoveBlock) {
                            e.preventDefault();
                            onMoveBlock(section.id, step[0] * KEY_STEP, step[1] * KEY_STEP);
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
                {labels.keyAlmostFull}
              </span>
              <LegendSwatch
                className="border border-border bg-[#E2E8F0]"
                label={labels.keySoldOut}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {listWhenNarrow && narrow && drawable.length > 0 ? (
        <div data-testid="venue-map-list" className="space-y-2">
          <p className="text-caption text-text-muted">{labels.listLead}</p>
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
                        ? labels.soldOut
                        : standingZone
                          ? labels.standing
                          : section.priceMinorFrom !== null
                            ? labels.priceFrom(formatPrice(section.priceMinorFrom))
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
          <p className="mb-2 text-caption text-text-muted">{labels.unplacedLead}</p>
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
                  ? ` - ${labels.priceFrom(formatPrice(section.priceMinorFrom))}`
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
function describe(
  section: VenueSectionSummary,
  formatPrice: (minor: number) => string,
  labels: VenueMapLabels,
): string {
  return labels.describe({
    name: section.name,
    soldOut: section.availableCount === 0,
    available: section.availableCount,
    total: section.totalCount,
    standing: section.kind === 'ZONE',
    price: section.priceMinorFrom !== null ? formatPrice(section.priceMinorFrom) : null,
  });
}

/** A viewBox number: a tenth of a map unit is finer than any screen shows. */
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Arrow keys as a direction on the map. */
const ARROW_STEPS: Record<string, [number, number] | undefined> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function centroidOf(points: VenuePoint[]): VenuePoint {
  const sum = points.reduce<[number, number]>((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
  return [Math.round(sum[0] / points.length), Math.round(sum[1] / points.length)];
}
