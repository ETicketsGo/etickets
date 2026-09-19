'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Accessibility, Minus, MonitorPlay, Plus, ScanLine } from 'lucide-react';
import {
  seatGroupName,
  seatInDirection,
  type SeatDirection,
  type SeatLayout,
  type SelectableSeat,
} from '@eticketsgo/web-kit';

type Row = SeatLayout['sections'][number]['rows'][number];

/** Multipliers on the fitted seat size. Index 1 is "fit". */
const ZOOM_STEPS = [0.75, 1, 1.3, 1.6, 1.9] as const;
const FIT_STEP = 1;

const ARROWS: Record<string, SeatDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

const isAccessible = (kind: string) => kind === 'WHEELCHAIR' || kind === 'COMPANION';

export interface SeatMapProps {
  layout: SeatLayout;
  selected: ReadonlySet<string>;
  /** Seats the current selection leaves on their own — outlined as a gentle warning. */
  stranded: ReadonlySet<string>;
  onTap: (seatId: string, row: readonly SelectableSeat[]) => void;
  formatMinor: (minor: number) => string;
  seatStatusLabel: (status: string) => string;
  /** The words for an accessible seat kind, e.g. "Wheelchair space". */
  kindLabel: (kind: string) => string | null;
}

/**
 * The room, seat by seat.
 *
 * ── WHAT CHANGED FROM THE OLD GRID, AND WHY ────────────────────────────────────────
 * - Seats sit at their real positions. The old grid pushed every row to the left edge and
 *   capped an aisle at three seats wide, so a row that starts further along — or a wide aisle —
 *   drew somewhere it is not in the room.
 * - The map fits its container and zooms. It used to be a fixed size inside a card that the
 *   page itself scrolled sideways on a phone, 206 px past the screen edge.
 * - Each block is headed by its price ("₹150 · UPPER BALCONY"). The prices used to live only
 *   in a legend under the map, so a buyer had to look away from the seats to compare them.
 * - One seat is a tab stop and the arrow keys move between available seats. Tab used to walk
 *   through every seat in the room, one at a time, before reaching anything else.
 * - Row letters stay pinned to the left edge while the map scrolls sideways.
 *
 * Every seat is still a real button whose accessible name reads "Seat A12, …, ₹200, available",
 * and a sold seat is still a disabled button: the status is carried by the name and by shape
 * (no number, no outline), never by colour alone.
 */
export function SeatMap({
  layout,
  selected,
  stranded,
  onTap,
  formatMinor,
  seatStatusLabel,
  kindLabel,
}: SeatMapProps) {
  const s = useTranslations('storefront.seats');
  const instructionsId = useId();

  const categories = useMemo(() => new Map(layout.categories.map((c) => [c.id, c])), [layout]);
  const rows = useMemo(() => layout.sections.flatMap((section) => section.rows), [layout]);
  const rowIndexOf = useMemo(() => new Map<Row, number>(rows.map((row, i) => [row, i])), [rows]);
  // Arrow keys move among seats that can be chosen; a sold seat is not somewhere to stop.
  const navRows = useMemo(
    () => rows.map((row) => ({ seats: row.seats.filter((seat) => seat.status === 'AVAILABLE') })),
    [rows],
  );
  const columns = useMemo(() => {
    const all = rows.flatMap((row) => row.seats.map((seat) => seat.colIndex));
    return all.length ? { min: Math.min(...all), max: Math.max(...all) } : { min: 1, max: 1 };
  }, [rows]);

  /*
    The seat size fits the room into the space available, within a comfortable range: never so
    small a finger cannot hit one, never so large a small room looks like a toy. Past that range
    the map scrolls inside its own box — the page never scrolls sideways.
  */
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [zoom, setZoom] = useState<number>(FIT_STEP);
  const span = columns.max - columns.min + 1;
  const fitted = width > 0 ? clamp((width - 48) / (span * 1.24), 22, 32) : 28;
  const size = Math.round(fitted * ZOOM_STEPS[zoom]);
  const gap = Math.max(3, Math.round(size * 0.22));
  const step = size + gap;
  const gutter = Math.max(28, Math.round(size * 1.15));

  const seatRefs = useRef(new Map<string, HTMLButtonElement>());
  const [active, setActive] = useState<string | null>(null);
  const tabStop = useMemo(() => {
    const available = navRows.flatMap((row) => row.seats.map((seat) => seat.id));
    return active && available.includes(active) ? active : (available[0] ?? null);
  }, [active, navRows]);

  const focal = layout.focal?.kind;
  const focalLabel =
    focal === 'FIELD'
      ? s('fieldThisWay')
      : focal && focal !== 'SCREEN'
        ? s('stageThisWay')
        : s('screenThisWay');

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-end gap-1">
        {(
          [
            { label: s('zoomOut'), icon: Minus, disabled: zoom === 0, next: zoom - 1 },
            { label: s('zoomReset'), icon: ScanLine, disabled: zoom === FIT_STEP, next: FIT_STEP },
            {
              label: s('zoomIn'),
              icon: Plus,
              disabled: zoom === ZOOM_STEPS.length - 1,
              next: zoom + 1,
            },
          ] as const
        ).map(({ label, icon: Icon, disabled, next }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => setZoom(next)}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border-input bg-background-surface text-text-secondary hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        ))}
      </div>

      <div
        ref={scroller}
        role="group"
        aria-label={s('mapLabel')}
        aria-describedby={instructionsId}
        // A scrollable box must be reachable by keyboard; with no seat to stop on, the box is.
        tabIndex={tabStop ? undefined : 0}
        className="overflow-auto overscroll-x-contain rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <p id={instructionsId} className="sr-only">
          {s('mapInstructions')}
        </p>
        <div className="mx-auto w-max pb-3 pr-2">
          {/* The screen — or stage — spans the seats, not the row letters beside them. */}
          <div style={{ paddingLeft: gutter }}>
            <div className="mx-auto h-1.5 w-[88%] rounded-t-[100%] bg-gradient-to-b from-action-primary/60 to-transparent" />
            <p className="mt-1 flex items-center justify-center gap-1.5 text-caption font-medium uppercase tracking-widest text-text-muted">
              <MonitorPlay className="h-3.5 w-3.5" aria-hidden />
              {focalLabel}
            </p>
          </div>

          <div className="mt-6 space-y-7">
            {layout.sections.map((section, sectionIndex) => {
              const sectionCategories = [
                ...new Set(section.rows.flatMap((row) => row.seats.map((seat) => seat.categoryId))),
              ]
                .map((id) => categories.get(id))
                .filter((category): category is NonNullable<typeof category> => Boolean(category));
              const price =
                sectionCategories.length === 1
                  ? formatMinor(sectionCategories[0].priceMinor)
                  : sectionCategories.length > 1
                    ? s('priceFrom', {
                        price: formatMinor(Math.min(...sectionCategories.map((c) => c.priceMinor))),
                      })
                    : null;
              const swatch = sectionCategories.length === 1 ? sectionCategories[0].colorHex : null;
              /*
                The price category's own name, when it is not the block's: "₹10 · BALCONY ·
                Premium". It is what the basket, Review & pay and the ticket call these seats, so
                the map says it too rather than letting "Premium" appear from nowhere later.
              */
              const tier =
                sectionCategories.length === 1
                  ? seatGroupName([section.name], sectionCategories[0].name).category
                  : null;

              return (
                <div key={`${sectionIndex}-${section.name}`}>
                  <div
                    className="mb-2.5 flex items-center gap-2 border-b border-border pb-1.5"
                    style={{ marginLeft: gutter }}
                  >
                    {swatch ? (
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: swatch }}
                      />
                    ) : null}
                    <p className="text-caption font-semibold uppercase tracking-wide text-text-secondary">
                      {price ? (
                        <>
                          <span className="tabular-nums text-text-primary">{price}</span>
                          <span aria-hidden> - </span>
                        </>
                      ) : null}
                      {section.name}
                      {tier ? (
                        <span className="font-medium normal-case tracking-normal text-text-muted">
                          {' '}
                          - {tier}
                        </span>
                      ) : null}
                    </p>
                  </div>

                  <div className="flex flex-col" style={{ rowGap: gap }}>
                    {section.rows.map((row) => {
                      const sorted = [...row.seats].sort((a, b) => a.colIndex - b.colIndex);
                      const rowIndex = rowIndexOf.get(row) ?? 0;
                      const selectable: SelectableSeat[] = sorted.map((seat) => ({
                        id: seat.id,
                        colIndex: seat.colIndex,
                        categoryId: seat.categoryId,
                        status: seat.status,
                        kind: seat.kind,
                      }));
                      return (
                        <div key={`${sectionIndex}-${row.label}`} className="flex items-center">
                          <span
                            className="sticky left-0 z-10 shrink-0 bg-background-surface pr-2 text-center text-caption font-medium text-text-muted"
                            style={{ width: gutter }}
                          >
                            {row.label}
                          </span>
                          <div className="flex">
                            {sorted.map((seat, index) => {
                              const previous =
                                index === 0 ? columns.min - 1 : sorted[index - 1].colIndex;
                              // Where the seat really is: after a leading offset or an aisle.
                              const offset =
                                (seat.colIndex - previous - 1) * step + (index === 0 ? 0 : gap);
                              const category = categories.get(seat.categoryId);
                              const available = seat.status === 'AVAILABLE';
                              const isSelected = selected.has(seat.id);
                              const kind = kindLabel(seat.kind);
                              const priceLabel = category ? formatMinor(category.priceMinor) : null;
                              const name = `${row.label}${seat.label}`;

                              const look = isSelected
                                ? 'border-action-primary bg-action-primary text-action-primary-foreground'
                                : available
                                  ? `bg-background-surface text-text-secondary hover:border-action-primary hover:bg-tint-primary hover:text-action-primary ${
                                      stranded.has(seat.id)
                                        ? 'border-dashed border-status-warning'
                                        : 'border-border-input'
                                    }`
                                  : seat.status === 'SOLD'
                                    ? 'cursor-not-allowed border-transparent bg-background-subtle'
                                    : 'cursor-not-allowed border-dashed border-border-strong bg-background-canvas';

                              return (
                                <button
                                  key={seat.id}
                                  ref={(element) => {
                                    if (element) seatRefs.current.set(seat.id, element);
                                    else seatRefs.current.delete(seat.id);
                                  }}
                                  type="button"
                                  disabled={!available}
                                  aria-pressed={isSelected}
                                  /*
                                    The ROW is part of the seat's name: "Seat 1" alone was the first
                                    seat of every row, identical to a screen reader.
                                  */
                                  aria-label={[
                                    s('seatName', { name }),
                                    kind,
                                    priceLabel,
                                    seatStatusLabel(seat.status),
                                  ]
                                    .filter(Boolean)
                                    .join(', ')}
                                  title={[name, category?.name, priceLabel, kind]
                                    .filter(Boolean)
                                    .join(' - ')}
                                  tabIndex={seat.id === tabStop ? 0 : -1}
                                  onFocus={() => setActive(seat.id)}
                                  onClick={() => onTap(seat.id, selectable)}
                                  onKeyDown={(event) => {
                                    const direction = ARROWS[event.key];
                                    if (!direction) return;
                                    event.preventDefault();
                                    const next = seatInDirection(
                                      navRows,
                                      { rowIndex, seatId: seat.id },
                                      direction,
                                    );
                                    if (!next) return;
                                    setActive(next.seatId);
                                    seatRefs.current.get(next.seatId)?.focus();
                                  }}
                                  style={{
                                    width: size,
                                    height: size,
                                    marginLeft: offset,
                                    fontSize: Math.max(9, Math.round(size * 0.37)),
                                  }}
                                  className={`flex shrink-0 items-center justify-center rounded-[0.3125rem] border font-medium tabular-nums leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background-surface motion-safe:transition-colors ${look}`}
                                >
                                  {/*
                                    Only a seat that can be had shows its number. A sold seat is a
                                    plain filled tile — the absence is the signal, as it is on a
                                    printed plan — and an accessible seat shows its mark instead.
                                  */}
                                  {available ? (
                                    isAccessible(seat.kind) ? (
                                      <Accessibility
                                        aria-hidden
                                        style={{ width: size * 0.55, height: size * 0.55 }}
                                      />
                                    ) : (
                                      seat.label.replace(/^[A-Za-z]+/, '')
                                    )
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
