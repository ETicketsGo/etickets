'use client';

import { useMemo } from 'react';
import { Info } from 'lucide-react';
import { Input } from '@eticketsgo/web-kit';
import {
  MAX_SECTION_SEATS,
  ROOM_SHAPES,
  planRoom,
  type RoomPlan,
  type RoomShape,
} from '@/lib/room-plan';

/**
 * Describing a room by what it IS, not by its row letters.
 *
 * ── WHY THIS REPLACED TWO TEXT BOXES ───────────────────────────────────────────────
 * The form asked for "Rows" (as "A-T") and "Seats per row". An organizer with a hundred-seat
 * cinema does not know whether that is A–S, A–Z or A–M, said so twice, and has to redo the
 * arithmetic for every screen in every venue. What they DO know is how big the room is and
 * what kind of room it is — and those two facts determine the rest.
 *
 * ── THE ARITHMETIC IS NOT HIDDEN, IT IS SHOWN ──────────────────────────────────────
 * The derived grid is displayed as plain words — "8 rows of 13, seating 104" — and the exact
 * fields are still there under "Set it exactly". Deriving something and concealing it would
 * only move the confusion: an organizer who cannot see what was chosen for them cannot tell
 * whether it matches their room.
 */
export interface RoomShapePickerProps {
  shapeKey: string;
  capacity: string;
  onChange: (next: { shapeKey: string; capacity: string; plan: RoomPlan }) => void;
}

export function RoomShapePicker({ shapeKey, capacity, onChange }: RoomShapePickerProps) {
  const shape: RoomShape = useMemo(
    () => ROOM_SHAPES.find((s) => s.key === shapeKey) ?? ROOM_SHAPES[1],
    [shapeKey],
  );
  const wanted = Number(capacity);
  const valid = Number.isFinite(wanted) && wanted >= 1;
  const plan = useMemo(() => (valid ? planRoom(wanted, shape) : null), [valid, wanted, shape]);

  const pick = (nextShape: RoomShape) => {
    // Changing the shape keeps the capacity — the room did not get bigger, it got a
    // different outline. Only an EMPTY box takes the new shape's typical size.
    const nextCapacity = valid ? capacity : String(nextShape.typicalSeats);
    onChange({
      shapeKey: nextShape.key,
      capacity: nextCapacity,
      plan: planRoom(Number(nextCapacity), nextShape),
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium">What kind of room is this?</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ROOM_SHAPES.map((s) => {
            const on = s.key === shape.key;
            return (
              <button
                key={s.key}
                type="button"
                aria-pressed={on}
                onClick={() => pick(s)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  on
                    ? 'border-action-primary bg-action-primary/5'
                    : 'border-border hover:bg-background-subtle'
                }`}
              >
                <span className="block text-sm font-medium text-text-primary">{s.label}</span>
                <span className="mt-0.5 block text-caption leading-snug text-text-muted">
                  {s.description}
                </span>
                <span className="mt-1 block text-caption tabular-nums text-text-muted">
                  usually about {s.typicalSeats} seats
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id="room-capacity"
          label="About how many seats?"
          type="number"
          min={1}
          placeholder={String(shape.typicalSeats)}
          value={capacity}
          onChange={(e) =>
            onChange({
              shapeKey: shape.key,
              capacity: e.target.value,
              plan: planRoom(Number(e.target.value), shape),
            })
          }
        />
        <div className="flex items-end">
          {plan ? (
            <div className="w-full rounded-md border border-border bg-background-subtle p-3">
              {/*
                What was derived, in words. An organizer who cannot see the grid chosen for
                them cannot tell whether it matches the room they are standing in.
              */}
              {/*
                The BOOKABLE count, which is what was asked for.

                Quoting the grid instead meant "100 seats" headlined 100 while the preview
                below counted 90 — the aisle column being sold as part of the house.
              */}
              <p className="text-sm font-medium text-text-primary">
                {plan.rows} row{plan.rows === 1 ? '' : 's'} of {plan.seatsPerRow} —{' '}
                <span className="tabular-nums">{plan.sellable}</span> seats to sell
              </p>
              <p className="mt-0.5 text-caption text-text-muted">
                Rows {plan.rowLabels[0]}–{plan.rowLabels[plan.rowLabels.length - 1]}
                {plan.sellable > wanted
                  ? ` · ${plan.sellable - wanted} more than you asked for`
                  : ''}
                {plan.aisle !== null ? ` · aisle at seat ${plan.aisle}` : ''}
              </p>
            </div>
          ) : (
            <p className="text-caption text-text-muted">
              Enter a number and the rows will be worked out for you.
            </p>
          )}
        </div>
      </div>

      {plan?.exceedsSection ? (
        /*
          Said plainly rather than silently capped.

          One section holds at most 2,400 seats. Quietly building the largest legal room for
          somebody who asked for five thousand would seat half their audience and look like
          it had worked.
        */
        <p className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/5 p-3 text-caption">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
          <span>
            One section holds up to {MAX_SECTION_SEATS.toLocaleString()} seats. This is the largest
            it can be — add another section for the rest, or use a venue shape if the space has
            tiers or blocks around a stage.
          </span>
        </p>
      ) : null}
    </div>
  );
}
