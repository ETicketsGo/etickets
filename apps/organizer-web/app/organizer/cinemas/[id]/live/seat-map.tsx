'use client';

import { Badge, type LiveSeat, type LiveSeatMap } from '@eticketsgo/web-kit';
import {
  OVERRIDE_LABEL,
  seatAccessibleName,
  seatActions,
  seatTone,
  type SeatTone,
} from './seat-presentation';

/**
 * The live seat map for one show.
 *
 * Renders exactly what the API reported — this component computes no state of its own. The
 * seats it draws belong to the layout version PINNED TO THE SHOW, so a screen that has since
 * been re-seated still shows the room this performance is actually playing in.
 *
 * Every seat is a real <button>, not a coloured div, so the map is operable by keyboard.
 * A graphical seat plan that only responds to a mouse is unusable for a duty manager who
 * navigates by keyboard, and no amount of colour fixes that.
 */

const TONE_CLASS: Record<SeatTone, string> = {
  // Text is carried in the accessible name and the legend, never by colour alone.
  available: 'bg-background-surface border-border text-text-secondary hover:border-border-strong',
  held: 'bg-status-warning/15 border-status-warning/50 text-status-warning',
  sold: 'bg-status-success/15 border-status-success/50 text-status-success',
  blocked: 'bg-status-error/12 border-status-error/50 text-status-error',
  gap: 'border-transparent bg-transparent',
};

/** A one-character hint so state survives greyscale and colour-blindness. */
const TONE_GLYPH: Record<SeatTone, string> = {
  available: '',
  held: '⏳',
  sold: '●',
  blocked: '✕',
  gap: '',
};

export function SeatMap({
  map,
  selectedSeatId,
  onSelect,
}: {
  map: LiveSeatMap;
  selectedSeatId: string | null;
  onSelect: (seat: LiveSeat) => void;
}) {
  return (
    <div className="space-y-6">
      <Legend />

      {/*
        Horizontal scroll is contained here rather than allowed to escape to the page. A wide
        auditorium must not make the whole dashboard scroll sideways.
      */}
      <div className="overflow-x-auto">
        <div className="min-w-max space-y-6">
          {map.sections.map((section) => (
            <section key={section.name} aria-label={`${section.name} seating`}>
              <h3 className="mb-2 text-sm font-semibold text-text-secondary">{section.name}</h3>
              <div className="space-y-1">
                {section.rows.map((row) => (
                  <div key={row.label} className="flex items-center gap-1">
                    <span
                      className="w-6 shrink-0 text-caption font-mono text-text-muted"
                      aria-hidden
                    >
                      {row.label}
                    </span>
                    {row.seats.map((seat) => (
                      <SeatButton
                        key={seat.seatId}
                        seat={seat}
                        selected={seat.seatId === selectedSeatId}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <p className="text-caption text-text-muted">
        Screen this way ↑ — seats shown are the layout version this show was scheduled against.
      </p>
    </div>
  );
}

function SeatButton({
  seat,
  selected,
  onSelect,
}: {
  seat: LiveSeat;
  selected: boolean;
  onSelect: (seat: LiveSeat) => void;
}) {
  const tone = seatTone(seat);

  if (tone === 'gap') {
    // Rendered so the row keeps its geometry, but not focusable and not announced —
    // an aisle is not something an operator can act on.
    return <span className="h-8 w-8 shrink-0" aria-hidden />;
  }

  const actions = seatActions(seat);
  return (
    <button
      type="button"
      onClick={() => onSelect(seat)}
      aria-label={seatAccessibleName(seat)}
      aria-pressed={selected}
      data-testid={`seat-${seat.label}`}
      data-status={seat.status}
      data-override={seat.overrideKind ?? ''}
      data-actionable={actions.block || actions.release ? 'true' : 'false'}
      className={`h-8 w-8 shrink-0 rounded border text-[0.625rem] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        TONE_CLASS[tone]
      } ${selected ? 'ring-2 ring-action-primary ring-offset-1' : ''}`}
    >
      <span aria-hidden>
        {TONE_GLYPH[tone] || seat.colIndex}
        {seat.kind === 'WHEELCHAIR' ? '♿' : ''}
      </span>
    </button>
  );
}

/**
 * The legend is not decoration.
 *
 * A seat map is a wall of coloured squares; without a key, an operator has to guess which
 * red means "sold" and which means "broken". It also carries the glyphs, so the mapping
 * survives for anyone who cannot distinguish the colours.
 */
function Legend() {
  const items: { tone: SeatTone; label: string }[] = [
    { tone: 'available', label: 'Available' },
    { tone: 'held', label: 'Held (checkout in progress)' },
    { tone: 'sold', label: 'Sold' },
    { tone: 'blocked', label: 'Blocked / withdrawn' },
  ];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Seat map legend">
      {items.map((i) => (
        <span key={i.tone} className="flex items-center gap-2 text-caption">
          <span
            className={`flex h-5 w-5 items-center justify-center rounded border text-[0.5rem] ${TONE_CLASS[i.tone]}`}
            aria-hidden
          >
            {TONE_GLYPH[i.tone]}
          </span>
          {i.label}
        </span>
      ))}
      <span className="flex items-center gap-2 text-caption">
        <span aria-hidden>♿</span> Wheelchair space
      </span>
    </div>
  );
}

/** Blocked-seat counts by reason, so the map has a summary an operator can scan. */
export function OverrideSummary({ map }: { map: LiveSeatMap }) {
  const counts = new Map<string, number>();
  for (const section of map.sections) {
    for (const row of section.rows) {
      for (const seat of row.seats) {
        if (seat.overrideKind) {
          counts.set(seat.overrideKind, (counts.get(seat.overrideKind) ?? 0) + 1);
        }
      }
    }
  }
  if (counts.size === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => (
          <Badge key={kind} tone="neutral">
            {OVERRIDE_LABEL[kind as keyof typeof OVERRIDE_LABEL]}: {count}
          </Badge>
        ))}
    </div>
  );
}
