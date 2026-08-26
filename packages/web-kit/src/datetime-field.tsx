'use client';

import { useMemo } from 'react';
import {
  TIME_OPTIONS,
  addDays,
  addHours,
  describe,
  join,
  split,
  todayLocal,
} from './datetime-value';

/**
 * Picking a date and a time without fighting the browser.
 *
 * ── WHAT WAS WRONG WITH `datetime-local` ───────────────────────────────────────────
 * It is one control that renders as five: day, month, year, hour, minute, meridiem, each
 * needing its own keystrokes or its own tiny spinner. Organizers schedule in round numbers
 * — 7pm on Saturday, doors at 6:30 — and the native control makes the round numbers cost
 * exactly as much as the awkward ones. Worse, its rendering differs per browser, so the
 * same wizard looks and behaves differently to two people on the same team.
 *
 * This splits it into the two questions actually being asked. The date keeps the native
 * calendar, which is genuinely good. The time becomes a list of the times events actually
 * start, at half-hour steps, which turns "7pm next Saturday" into two clicks.
 *
 * ── THE FORMAT IS DELIBERATELY UNCHANGED ───────────────────────────────────────────
 * The value in and out is the same `YYYY-MM-DDTHH:mm` local string `datetime-local`
 * produces, so this drops into existing forms without touching what they submit — and,
 * more importantly, without introducing a second way for a time to reach the API.
 *
 * The value arithmetic lives in `datetime-value.ts`, where the rule that no string is ever
 * fed to `new Date()` is stated and tested.
 */

const inputClass =
  'rounded-md border border-border bg-background-surface px-3 py-2 text-[0.9375rem] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60';

const chipClass =
  'rounded-full border border-border px-2.5 py-1 text-caption text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export function DateTimeField({
  id,
  label,
  value,
  onChange,
  error,
  min,
  /**
   * The start this field ends. Present only on an "ends at" field, and it changes the
   * shortcuts from "when does it begin" to "how long does it run", which is the question
   * an organizer is actually answering.
   */
  relativeTo,
  /** Timezone name to show beside the echo, e.g. "Asia/Kolkata". */
  timeZoneLabel,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  min?: string;
  relativeTo?: string;
  timeZoneLabel?: string;
  disabled?: boolean;
}) {
  const { date, time } = split(value);
  /*
    Ids derived from the field's own id, not from `useId()`.

    The three controls need distinguishing from outside — by a label, by a test, by anything
    that has to point at one of them — and a React-generated id changes between renders and
    between builds. `ss0-time` is stable and readable, and the caller already owns `ss0`.
  */
  const timeId = `${id}-time`;
  const exactId = `${id}-exact`;
  const described = describe(value);

  const shortcuts = useMemo(() => {
    if (relativeTo) {
      const start = split(relativeTo);
      if (!start.date || !start.time) return [];
      return [1, 2, 3]
        .map((hours) => {
          const end = addHours(start.time, hours);
          return end ? { label: `+${hours}h`, date: start.date, time: end } : null;
        })
        .filter((s): s is { label: string; date: string; time: string } => s !== null);
    }
    const today = todayLocal();
    // Deliberately date-only: the shortcut answers "which day", and forcing a time along
    // with it would overwrite one the organizer had already chosen.
    return [
      { label: 'Today', date: today, time: time || '19:00' },
      { label: 'Tomorrow', date: addDays(today, 1), time: time || '19:00' },
      /*
        "In a week", not "Next week".

        The wizard this sits in has a "Next" button a few centimetres below, and two
        adjacent controls both starting with "Next" is a genuine misread — a person
        skim-clicking the wrong one changes the date instead of advancing the step. It
        showed up first as an ambiguous test selector, which is the same problem wearing
        a different hat.
      */
      { label: 'In a week', date: addDays(today, 7), time: time || '19:00' },
    ];
  }, [relativeTo, time]);

  return (
    /*
      A fieldset, because this is one question answered by three controls.

      The first version gave each control a label starting with the field name — "Starts
      at", "Starts at — time", "Starts at — exact time" — which announces as three separate
      fields and is genuinely ambiguous. An end-to-end test asking for the control labelled
      "Starts at" found three of them and could go no further, which is precisely the
      confusion a person using a screen reader would have had. The legend names the question
      once; each control says only what it contributes to the answer.
    */
    <fieldset className="space-y-1.5 border-0 p-0">
      <legend className="mb-1.5 block text-caption font-medium text-text-secondary">{label}</legend>

      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          type="date"
          aria-label="Date"
          value={date}
          min={min ? split(min).date : undefined}
          disabled={disabled}
          onChange={(e) => onChange(join(e.target.value, time))}
          className={`${inputClass} min-w-[9rem] flex-1`}
          aria-invalid={error ? true : undefined}
        />
        {/*
          A select, not a time input. Half-hour steps cover essentially every real showtime
          and cost one click; the native time spinner costs four interactions to say 7pm.
          The odd 7:15 start is still reachable — see the free-entry escape hatch below.
        */}
        <select
          id={timeId}
          aria-label="Time"
          value={TIME_OPTIONS.some((o) => o.value === time) ? time : ''}
          disabled={disabled}
          onChange={(e) => onChange(join(date, e.target.value))}
          className={`${inputClass} min-w-[7.5rem]`}
        >
          <option value="">Time…</option>
          {/* An unusual time already saved must still be selectable, or opening the form
              and saving it again would silently round it to the nearest half hour. */}
          {time && !TIME_OPTIONS.some((o) => o.value === time) ? (
            <option value={time}>{time}</option>
          ) : null}
          {TIME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          id={exactId}
          type="time"
          aria-label="Exact time"
          value={time}
          disabled={disabled}
          onChange={(e) => onChange(join(date, e.target.value))}
          className={`${inputClass} w-[7rem]`}
          // The escape hatch for 7:15 doors. Kept beside the list rather than behind a
          // toggle: an organizer who needs it should not have to discover a mode.
        />
      </div>

      {shortcuts.length > 0 && !disabled ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {relativeTo ? <span className="text-caption text-text-muted">Runs for</span> : null}
          {shortcuts.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onChange(join(s.date, s.time))}
              className={chipClass}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}

      {/*
        The value read back as a sentence. This is the whole point of the component: an
        organizer who mistypes 2025 for 2026, or picks AM for a 7pm show, sees it here in
        words rather than discovering it when nobody turns up.
      */}
      {described ? (
        <p className="text-caption text-text-muted">
          {described}
          {timeZoneLabel ? ` · ${timeZoneLabel}` : ''}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
