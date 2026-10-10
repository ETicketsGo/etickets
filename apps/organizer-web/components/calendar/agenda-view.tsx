'use client';

import { useEffect, useState } from 'react';
import { CalendarDayCard, type CalendarEntry, type OpenCalendarEntry } from '@eticketsgo/web-kit';
import { formatDayLong, type CalendarSession, type DayKey } from '@/lib/calendar';

/** Sessions listed per day before "Show N more"; the rest render only when asked for. */
export const AGENDA_DAY_CAP = 8;

const NOUN = { one: 'session', many: 'sessions' };

/**
 * The calendar as a list, one card per day that has something on it. The default on a phone,
 * where a seven-column grid cannot show a title. The cards and rows are the shared calendar's;
 * what is here is the organizer's own behaviour: which days are opened in full, and the day
 * "+N more" in the week sent the organizer to, scrolled to and focused.
 */
export function AgendaView({
  days,
  entries,
  today,
  focusDay,
  onOpen,
}: {
  days: DayKey[];
  entries: Map<DayKey, CalendarEntry<CalendarSession>[]>;
  today: DayKey;
  /** A day to scroll to and open in full - set when "+N more" sent the organizer here. */
  focusDay: DayKey | null;
  onOpen: OpenCalendarEntry<CalendarSession>;
}) {
  const [expanded, setExpanded] = useState<Set<DayKey>>(() => new Set(focusDay ? [focusDay] : []));

  useEffect(() => {
    if (!focusDay) return;
    setExpanded((prev) => new Set(prev).add(focusDay));
    const el = document.getElementById(`agenda-${focusDay}`);
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [focusDay]);

  const withSessions = days.filter((d) => (entries.get(d)?.length ?? 0) > 0);
  if (withSessions.length === 0) return null;

  return (
    <div className="space-y-4">
      {withSessions.map((day) => (
        <CalendarDayCard
          key={day}
          day={day}
          heading={formatDayLong(day)}
          entries={entries.get(day) ?? []}
          today={today}
          noun={NOUN}
          onOpen={onOpen}
          cap={AGENDA_DAY_CAP}
          expanded={expanded.has(day)}
          onExpand={(d) => setExpanded((prev) => new Set(prev).add(d))}
          headingId={`agenda-${day}`}
          testId={`agenda-day-${day}`}
        />
      ))}
    </div>
  );
}
