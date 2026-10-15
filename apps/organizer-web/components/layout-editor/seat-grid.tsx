'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Accessibility, EyeOff, HandHeart, Lock } from 'lucide-react';
import {
  SEAT_KIND_LABEL,
  categoryKeyAt,
  seatKindFromCode,
  seatLabelAt,
  type LayoutDocument,
  type LayoutSeatKind,
} from '@eticketsgo/shared-types';
import { rangeBetween, refKey, rowRefs, type SeatRef } from '@/lib/layout-editor';

/**
 * The editing surface: a section's rows as seats a person can select.
 *
 * -- HOW SELECTING WORKS -----------------------------------------------------------------
 * A click (or a tap, or Space) toggles one seat. Shift-click selects everything between the
 * last seat chosen and this one. Dragging with a mouse selects the rectangle dragged over. The
 * row letter selects the whole row. Arrow keys move between seats, and Shift with an arrow adds
 * the seat moved to - so every selection a mouse can make, a keyboard can make too.
 *
 * -- WHAT A SEAT SHOWS --------------------------------------------------------------------
 * Its number, its ticket category as the colour of its outline, and its kind as an icon AND in
 * its accessible name - never colour alone. A removed seat (a gap) keeps its place as a dashed
 * outline, so it can be selected and restored.
 */

const KIND_ICON: Partial<Record<LayoutSeatKind, typeof Accessibility>> = {
  WHEELCHAIR: Accessibility,
  COMPANION: HandHeart,
  RESTRICTED_VIEW: EyeOff,
  HOUSE: Lock,
};

export interface SeatGridProps {
  doc: LayoutDocument;
  /** Which sections to draw: every section of a room of rows, or one block of a venue map. */
  sections: number[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Read-only: a published layout is shown, never edited. */
  readOnly?: boolean;
  /** What the room faces, drawn above the first row. */
  focalLabel?: string | null;
}

interface Drag {
  start: SeatRef;
  base: Set<string>;
  adding: boolean;
  moved: boolean;
}

export function SeatGrid({
  doc,
  sections,
  selected,
  onChange,
  readOnly = false,
  focalLabel,
}: SeatGridProps) {
  const categories = useMemo(
    () => new Map(doc.categories.map((c) => [c.key, c])),
    [doc.categories],
  );
  const [anchor, setAnchor] = useState<SeatRef | null>(null);
  const [focus, setFocus] = useState<SeatRef | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  // The seat that takes Tab: the focused one, else the first seat drawn.
  const first: SeatRef | null = sections.length > 0 ? { s: sections[0], r: 0, p: 0 } : null;
  const tabStop = focus && sections.includes(focus.s) ? focus : first;

  useEffect(() => {
    const end = () => {
      if (drag.current?.moved) {
        // Swallow the click a drag ends with (when it ends on a seat) - and only that one. A drag
        // that ends between seats fires no click, and left set, this flag ate the person's next
        // real click.
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
      drag.current = null;
    };
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, []);

  const apply = (base: Set<string>, refsToApply: SeatRef[], adding: boolean) => {
    const next = new Set(base);
    for (const ref of refsToApply) {
      if (adding) next.add(refKey(ref));
      else next.delete(refKey(ref));
    }
    return next;
  };

  const toggle = (ref: SeatRef, extend: boolean) => {
    if (readOnly) return;
    if (extend && anchor && anchor.s === ref.s) {
      onChange(apply(new Set(selected), rangeBetween(doc, anchor, ref), true));
    } else {
      const next = new Set(selected);
      if (next.has(refKey(ref))) next.delete(refKey(ref));
      else next.add(refKey(ref));
      onChange(next);
      setAnchor(ref);
    }
  };

  const toggleRow = (s: number, r: number) => {
    if (readOnly) return;
    const row = rowRefs(doc, s, r);
    const all = row.every((ref) => selected.has(refKey(ref)));
    onChange(apply(new Set(selected), row, !all));
    setAnchor(row[0] ?? null);
  };

  /** Where an arrow key goes from a seat, across the drawn sections' rows. */
  const step = (from: SeatRef, key: string): SeatRef | null => {
    const lines: { s: number; r: number }[] = sections.flatMap((s) =>
      (doc.sections[s]?.rows ?? []).map((_row, r) => ({ s, r })),
    );
    const line = lines.findIndex((l) => l.s === from.s && l.r === from.r);
    const widthOf = (l: { s: number; r: number }) => doc.sections[l.s].rows[l.r].kinds.length;
    if (key === 'ArrowLeft') return from.p > 0 ? { ...from, p: from.p - 1 } : null;
    if (key === 'ArrowRight')
      return from.p < widthOf(lines[line]) - 1 ? { ...from, p: from.p + 1 } : null;
    const target =
      key === 'ArrowUp' ? lines[line - 1] : key === 'ArrowDown' ? lines[line + 1] : null;
    if (!target) return null;
    return { s: target.s, r: target.r, p: Math.min(from.p, widthOf(target) - 1) };
  };

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, ref: SeatRef) => {
    const next = step(ref, event.key);
    if (!next) return;
    event.preventDefault();
    setFocus(next);
    refs.current.get(refKey(next))?.focus();
    if (event.shiftKey && !readOnly) {
      onChange(apply(new Set(selected), [next], true));
      setAnchor(anchor ?? ref);
    }
  };

  return (
    <div className="space-y-6" data-testid="seat-grid">
      {focalLabel ? (
        <div
          aria-hidden
          className="mx-auto w-2/3 rounded-md border border-border bg-background-subtle py-1 text-center text-caption font-semibold tracking-wide text-text-secondary"
        >
          {focalLabel}
        </div>
      ) : null}
      {sections.map((s) => {
        const section = doc.sections[s];
        if (!section) return null;
        return (
          <div key={s} className="space-y-1.5" role="group" aria-label={`Section ${section.name}`}>
            {sections.length > 1 ? (
              <p className="text-caption font-semibold text-text-secondary">{section.name}</p>
            ) : null}
            {section.rows.map((row, r) => (
              <div key={`${s}-${r}`} className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => toggleRow(s, r)}
                  aria-label={`Select row ${row.label} of ${section.name}`}
                  className="h-7 w-8 shrink-0 rounded text-caption font-semibold text-text-secondary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:hover:bg-transparent"
                >
                  {row.label}
                </button>
                <div className="flex gap-1">
                  {[...row.kinds].map((code, p) => {
                    const ref = { s, r, p };
                    const key = refKey(ref);
                    const kind = seatKindFromCode(code);
                    const category = categories.get(categoryKeyAt(section, row, p));
                    const on = selected.has(key);
                    const number = seatLabelAt(row, p);
                    const gap = kind === 'GAP';
                    const Icon = KIND_ICON[kind];
                    const name = gap
                      ? `Row ${row.label}, no seat (removed seat ${number})`
                      : `Row ${row.label} seat ${number}, ${category?.name ?? 'no category'}${
                          kind === 'SEAT' ? '' : `, ${SEAT_KIND_LABEL[kind]}`
                        }`;
                    const isStop = tabStop && tabStop.s === s && tabStop.r === r && tabStop.p === p;
                    return (
                      <button
                        key={p}
                        ref={(el) => {
                          if (el) refs.current.set(key, el);
                          else refs.current.delete(key);
                        }}
                        type="button"
                        data-seat={`${row.label}${number}`}
                        data-kind={kind}
                        aria-pressed={readOnly ? undefined : on}
                        aria-label={name}
                        title={name}
                        tabIndex={isStop ? 0 : -1}
                        onFocus={() => setFocus(ref)}
                        onKeyDown={(e) => onKey(e, ref)}
                        onPointerDown={(e) => {
                          if (readOnly || e.pointerType !== 'mouse' || e.button !== 0) return;
                          if (e.shiftKey) return;
                          drag.current = {
                            start: ref,
                            base: new Set(selected),
                            adding: !selected.has(key),
                            moved: false,
                          };
                        }}
                        onPointerEnter={(e) => {
                          const d = drag.current;
                          if (!d || e.buttons !== 1 || d.start.s !== s) return;
                          d.moved = true;
                          onChange(apply(d.base, rangeBetween(doc, d.start, ref), d.adding));
                        }}
                        onClick={(e) => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          toggle(ref, e.shiftKey);
                        }}
                        style={
                          gap || !category?.colorHex
                            ? undefined
                            : {
                                borderColor: category.colorHex,
                                boxShadow: on ? undefined : `inset 0 -3px 0 ${category.colorHex}`,
                              }
                        }
                        className={`relative flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-md border-2 text-[0.6875rem] font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                          gap ? 'border-dashed border-border text-text-muted' : 'text-text-primary'
                        } ${
                          on
                            ? 'bg-tint-primary ring-2 ring-action-primary ring-offset-1'
                            : gap
                              ? 'bg-transparent'
                              : 'bg-background-surface'
                        } ${
                          readOnly
                            ? 'cursor-default'
                            : on
                              ? 'cursor-pointer'
                              : 'cursor-pointer hover:bg-background-subtle'
                        }`}
                      >
                        {Icon ? (
                          <Icon className="h-3.5 w-3.5 text-text-primary" aria-hidden />
                        ) : gap ? null : (
                          number
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
