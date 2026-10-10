'use client';

import type { LiveSeatMap } from '@eticketsgo/web-kit';
import { seatTone } from '@/app/organizer/cinemas/[id]/live/seat-presentation';

/**
 * A small, read-only picture of a show's seat layout: every row, each seat in its category's
 * colour, sold seats filled, aisles left as gaps, and the screen along the top.
 *
 * It answers "which layout is this show seated from, and how full is it" without opening the
 * live seat view. Nothing here is interactive - blocking and releasing seats stay on the live
 * view, which owns those endpoints and their confirmations. Drawn from the live seat map the
 * show is pinned to, so it is the layout the show actually sells, not the screen's current one.
 *
 * One image to assistive technology (`role="img"`) with the counts in its name; a few hundred
 * unlabelled squares would be noise.
 */
export function SeatPreview({ map }: { map: LiveSeatMap }) {
  const colour = new Map(map.categories.map((c) => [c.id, c.colorHex]));
  const rows = map.sections.flatMap((s) => s.rows);
  const seats = rows.flatMap((r) => r.seats).filter((s) => s.kind !== 'GAP');
  if (seats.length === 0) return null;
  const sold = seats.filter((s) => seatTone(s) === 'sold').length;
  const blocked = seats.filter((s) => seatTone(s) === 'blocked').length;
  const widest = Math.max(...rows.map((r) => r.seats.length), 1);
  // Big enough to read on a phone, small enough that a 30-seat row fits a 360px drawer.
  const cell = widest > 28 ? 7 : widest > 18 ? 9 : widest > 12 ? 11 : 14;
  const name = `Seat layout: ${seats.length} seats in ${rows.length} rows, ${sold} sold${
    blocked ? `, ${blocked} blocked` : ''
  }`;

  return (
    <figure className="space-y-2">
      <div
        role="img"
        aria-label={name}
        className="overflow-x-auto rounded-md border border-border bg-background-subtle px-3 pb-3 pt-2"
      >
        <div className="mx-auto mb-3 h-1.5 w-3/4 rounded-full bg-text-muted/40" aria-hidden />
        <div className="mx-auto flex w-max flex-col gap-[3px]" aria-hidden>
          {map.sections.map((section, si) => (
            <div key={`${section.name}-${si}`} className="flex flex-col gap-[3px]">
              {si > 0 ? <div className="h-1.5" /> : null}
              {section.rows.map((row) => (
                <div key={row.label} className="flex items-center gap-[3px]">
                  <span className="w-4 shrink-0 text-right text-[0.5625rem] font-medium tabular-nums text-text-muted">
                    {row.label}
                  </span>
                  {row.seats.map((seat) => {
                    const tone = seatTone(seat);
                    if (tone === 'gap')
                      return <span key={seat.seatId} style={{ width: cell, height: cell }} />;
                    const c = colour.get(seat.categoryId) ?? null;
                    return (
                      <span
                        key={seat.seatId}
                        className={`rounded-[2px] border ${
                          tone === 'sold'
                            ? 'border-text-secondary bg-text-secondary'
                            : tone === 'blocked'
                              ? 'border-text-muted bg-[repeating-linear-gradient(45deg,hsl(var(--text-muted)/0.6)_0_2px,transparent_2px_4px)]'
                              : 'border-text-muted bg-background-surface'
                        }`}
                        style={{
                          width: cell,
                          height: cell,
                          borderColor: tone === 'available' && c ? c : undefined,
                          backgroundColor: tone === 'available' && c ? `${c}33` : undefined,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="flex flex-wrap gap-x-3 gap-y-1 text-micro text-text-secondary">
        {map.categories.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-[2px] border border-text-muted bg-background-surface"
              style={
                c.colorHex
                  ? { borderColor: c.colorHex, backgroundColor: `${c.colorHex}33` }
                  : undefined
              }
            />
            {c.name}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-text-secondary" />
          Sold
        </span>
      </figcaption>
    </figure>
  );
}
