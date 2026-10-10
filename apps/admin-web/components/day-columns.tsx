'use client';

import { useId, useState } from 'react';

/**
 * One measure, day by day, as columns - with the same figures one click away as a table.
 *
 * ── WHY COLUMNS AND NOT A BAR PER LINE ─────────────────────────────────────────────
 * The reports drew a day as a horizontal bar with its date and amount beside it, one line per
 * day. Thirty days was a column of thirty lines taller than the screen, and the shape - which is
 * the point of drawing it - could not be seen at once. A day is a moment in a sequence, so it
 * reads left to right.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────────────
 * Draw two currencies on one axis. A caller passes one currency's series; the reports page
 * renders one chart per currency, scaled within itself, for the reason it always has: a shared
 * axis would compare paise to cents.
 *
 * One series, so one colour (the primary) and no legend - the card's title names the measure.
 * The exact value of a day is in the tooltip on hover and in the table view, never only in a
 * colour or a height.
 */
export interface DayPoint {
  /** `YYYY-MM-DD`. */
  day: string;
  value: number;
  /** The value as a person reads it - "₹1,250" or "4". */
  display: string;
}

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function DayColumns({
  points,
  label,
  emptyText = 'Nothing in this range.',
}: {
  points: DayPoint[];
  /** What is measured, for the table caption and the chart's accessible name. */
  label: string;
  emptyText?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const tableId = useId();

  if (points.length === 0) {
    return <p className="py-6 text-center text-ui text-text-muted">{emptyText}</p>;
  }

  const max = Math.max(...points.map((p) => p.value), 0);
  const peak = points.reduce((best, p) => (p.value > best.value ? p : best), points[0]);
  const ticks = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (v, i, all) => all.indexOf(v) === i,
  );
  const shown = hover === null ? null : points[hover];
  const zero = points.find((p) => p.value === 0)?.display ?? '0';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-text-secondary" aria-live="polite">
          {shown ? (
            <>
              <span className="font-semibold text-text-primary">{shortDay(shown.day)}</span>
              {': '}
              <span className="tabular-nums">{shown.display}</span>
            </>
          ) : (
            <>
              Highest day:{' '}
              <span className="font-semibold text-text-primary">{shortDay(peak.day)}</span>{' '}
              <span className="tabular-nums">({peak.display})</span>
            </>
          )}
        </p>
        <button
          type="button"
          aria-expanded={asTable}
          aria-controls={tableId}
          onClick={() => setAsTable((v) => !v)}
          className="rounded-sm text-caption font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {asTable ? 'Show as a chart' : 'Show as a table'}
        </button>
      </div>

      {!asTable && (
        <div
          role="img"
          aria-label={`${label}, ${points.length} days. Highest ${peak.display} on ${shortDay(peak.day)}.`}
          className="flex gap-2"
        >
          {/*
            The scale, in the series' own unit: its top is the highest day and its floor is zero.
            Written once at each end rather than as a ladder of rounded steps, because a rounded
            step would be a number the API never returned.
          */}
          <div
            aria-hidden
            className="flex h-44 shrink-0 flex-col justify-between text-right text-micro tabular-nums text-text-muted"
          >
            <span className="-translate-y-1/2">{peak.display}</span>
            <span className="translate-y-1/2">{zero}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="relative h-44 border-b border-border">
              {/* Recessive gridlines: the top of the scale and its middle. */}
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 border-t border-dashed border-border"
              />
              <div
                aria-hidden
                className="absolute inset-x-0 top-1/2 border-t border-dashed border-border/70"
              />
              <div
                className={`absolute inset-0 flex items-end ${points.length > 92 ? 'gap-0' : 'gap-[2px]'}`}
                onMouseLeave={() => setHover(null)}
              >
                {points.map((p, i) => {
                  const pct = max > 0 ? (p.value / max) * 100 : 0;
                  return (
                    <div
                      key={p.day}
                      // The hit target is the whole column, not just the bar: a zero day is still a day.
                      className="group flex h-full min-w-0 flex-1 items-end"
                      onMouseEnter={() => setHover(i)}
                    >
                      <div
                        className={`w-full rounded-t-[4px] transition-colors duration-150 motion-reduce:transition-none ${
                          hover === i ? 'bg-action-primary-hover' : 'bg-action-primary'
                        }`}
                        // A day with something in it is never drawn as nothing.
                        style={{ height: p.value > 0 ? `max(${pct}%, 2px)` : '0px' }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            <div
              aria-hidden
              className="relative mt-1.5 h-4 text-micro tabular-nums text-text-muted"
            >
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute whitespace-nowrap"
                  style={
                    t === 0
                      ? { left: 0 }
                      : t === points.length - 1
                        ? { right: 0 }
                        : {
                            left: `${((t + 0.5) / points.length) * 100}%`,
                            transform: 'translateX(-50%)',
                          }
                  }
                >
                  {shortDay(points[t].day)}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div
        id={tableId}
        hidden={!asTable}
        // It scrolls, so the keyboard needs a way in: one tab stop lets the arrow keys move it.
        tabIndex={asTable ? 0 : -1}
        className="max-h-80 overflow-y-auto rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full text-ui">
          <caption className="sr-only">{label}</caption>
          <thead className="sticky top-0 bg-background-subtle">
            <tr>
              <th
                scope="col"
                className="px-4 py-2 text-left text-micro font-semibold uppercase tracking-[0.06em] text-text-muted"
              >
                Day
              </th>
              <th
                scope="col"
                className="px-4 py-2 text-right text-micro font-semibold uppercase tracking-[0.06em] text-text-muted"
              >
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.day} className="border-t border-border/70">
                <td className="px-4 py-2 text-text-secondary">{shortDay(p.day)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-text-primary">{p.display}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
