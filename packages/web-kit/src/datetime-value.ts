/**
 * The value arithmetic behind `DateTimeField`, kept apart from the component so it can be
 * tested without a DOM — and so the rule that matters is stated in one place.
 *
 * ── NO Date PARSING, ANYWHERE ──────────────────────────────────────────────────────
 * Every operation here is string surgery on the local `YYYY-MM-DDTHH:mm` form that
 * `datetime-local` produces. Round-tripping such a string through `new Date(value)` parses
 * it as UTC on some paths and local on others, and reformatting then shows the previous
 * evening — the timezone bug this product has already shipped more than once. The two
 * places a Date IS constructed take explicit numeric parts, never a string.
 */
/** Half-hour steps: the granularity real showtimes use. 48 options, one scroll. */
export const TIME_OPTIONS: { value: string; label: string }[] = Array.from(
  { length: 48 },
  (_, i) => {
    const hour = Math.floor(i / 2);
    const minute = i % 2 === 0 ? '00' : '30';
    const value = `${String(hour).padStart(2, '0')}:${minute}`;
    const meridiem = hour < 12 ? 'AM' : 'PM';
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return { value, label: `${display}:${minute} ${meridiem}` };
  },
);

/** Splits the combined value, tolerating the empty and half-filled states. */
export function split(value: string): { date: string; time: string } {
  const [date = '', time = ''] = value.split('T');
  // Seconds are dropped: the API stores them, nothing schedules on them, and showing
  // ":00" in a picker only invites somebody to try editing it.
  return { date, time: time.slice(0, 5) };
}

export function join(date: string, time: string): string {
  if (!date && !time) return '';
  return `${date}T${time}`;
}

/**
 * "Sat 30 Aug 2026, 7:00 PM" — the sentence a human would say.
 *
 * Built from the parts rather than by parsing, so it cannot disagree with the value shown
 * in the inputs. Returns null while the value is incomplete: a half-written date should
 * read as unfinished, not as a confident wrong answer.
 */
export function describe(value: string): string | null {
  const { date, time } = split(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [, y, mo, d] = m;
  // Local midday, from explicit numeric parts. Midday rather than midnight so that a DST
  // transition cannot roll the weekday backwards.
  const when = new Date(Number(y), Number(mo) - 1, Number(d), 12);
  const weekday = when.toLocaleDateString(undefined, { weekday: 'short' });
  const month = when.toLocaleDateString(undefined, { month: 'short' });
  const [hh, mm] = time.split(':');
  const hour = Number(hh);
  const meridiem = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${weekday} ${Number(d)} ${month} ${y}, ${display}:${mm} ${meridiem}`;
}

/** Today in local time as YYYY-MM-DD, without a UTC round-trip. */
export function todayLocal(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Adds days to a YYYY-MM-DD, keeping it a local calendar date throughout. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + days);
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, '0'),
    String(next.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Adds whole hours to HH:mm. Returns null if it would cross midnight. */
export function addHours(time: string, hours: number): string | null {
  const [h, m] = time.split(':').map(Number);
  const next = h + hours;
  // Refuses rather than wrapping. A session that silently ends at 01:00 the *same*
  // morning — before it started — is the bug this guard exists to prevent.
  if (next > 23) return null;
  return `${String(next).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
