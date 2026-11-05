/**
 * Quiet hours: the local night during which a campaign must not start or keep sending.
 *
 * ── WHY STEP THROUGH TIME INSTEAD OF DOING OFFSET ARITHMETIC ───────────────────────
 * "The next 08:00 in Asia/Kolkata" is easy; "the next 08:00 in America/New_York on the night
 * the clocks change" is where hand-written offset maths goes wrong. `Intl` knows every zone's
 * rules, so this asks it for the local wall-clock time and walks forward in five-minute steps.
 * At most 24 hours of steps (288), only when a schedule is checked. Cheap and always right.
 */

export interface QuietHours {
  /** Local "HH:MM" the quiet period starts. */
  start: string;
  /** Local "HH:MM" it ends. May be earlier than `start` (it crosses midnight). */
  end: string;
}

/** The platform default: no campaign mail between 21:00 and 08:00 where the audience is. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: '21:00', end: '08:00' };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidHhMm(value: string): boolean {
  return HHMM.test(value);
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`Not a time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The local wall-clock minute of the day (0..1439) of `at` in `zone`. */
export function localMinuteOfDay(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
}

/** Whether `at` falls inside the quiet period. Start inclusive, end exclusive. */
export function isQuietTime(at: Date, zone: string, quiet: QuietHours | null | undefined): boolean {
  if (!quiet) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const now = localMinuteOfDay(at, zone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

const STEP_MS = 5 * 60_000;

/** The first moment at or after `at` that is outside the quiet period. */
export function nextSendableTime(
  at: Date,
  zone: string,
  quiet: QuietHours | null | undefined,
): Date {
  if (!isQuietTime(at, zone, quiet)) return at;
  // Align to the next five-minute mark so the answer reads as a time a person would pick.
  let t = Math.ceil(at.getTime() / STEP_MS) * STEP_MS;
  for (let i = 0; i < 24 * 12 + 1; i++) {
    if (!isQuietTime(new Date(t), zone, quiet)) return new Date(t);
    t += STEP_MS;
  }
  // Only reachable with a 24-hour quiet period, which validation refuses.
  return new Date(t);
}

/** Validation for an organizer's setting. Null is "no quiet hours". */
export function quietHoursProblem(quiet: QuietHours | null | undefined): string | null {
  if (!quiet) return null;
  if (!isValidHhMm(quiet.start) || !isValidHhMm(quiet.end)) {
    return 'Quiet hours need a start and an end time, like 21:00 and 08:00.';
  }
  if (quiet.start === quiet.end) return 'Quiet hours need a start and an end that differ.';
  return null;
}
