import { instantToZonedWallClock, zonedWallClockToInstant } from './shows.service';

/**
 * Wall-clock ↔ instant conversion across daylight-saving transitions.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 * The conversion measured the zone's offset ONCE, at the wall-clock time read as if it were
 * UTC. That is a different instant from the answer, and on a transition day the two can sit
 * on opposite sides of the change.
 *
 * Sydney, 2026-10-04, the morning clocks go forward: 00:30 was stored as an instant that
 * read back as 23:30 on OCTOBER 3. An hour early, and on the wrong local day — so the show
 * would have been advertised on the wrong date and filed under the wrong day's schedule.
 *
 * It went unnoticed because India never observes DST, so no fixture in the launch market
 * could produce it, and because the e2e fixture that DID catch it picks its date from
 * `Date.now()` — it lands on a transition date only for part of the year, and only for part
 * of the day. It passed at 07:59 UTC and failed at 16:14 UTC on the same date.
 *
 * These cases are fixed dates. They do not depend on when the suite runs.
 */
const roundTrips = (timeZone: string, date: string, time: string) => {
  const instant = zonedWallClockToInstant(date, time, timeZone);
  return {
    time: instantToZonedWallClock(instant, timeZone),
    date: new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant),
    iso: instant.toISOString(),
  };
};

describe('a wall-clock time survives the round trip', () => {
  it.each([
    // The exact case that was wrong. 00:30 is BEFORE the 02:00 jump, so it is still +10.
    ['Australia/Sydney', '2026-10-04', '00:30', '2026-10-03T14:30:00.000Z'],
    // The day before, same clock time, no transition involved.
    ['Australia/Sydney', '2026-10-03', '00:30', '2026-10-02T14:30:00.000Z'],
    // After the jump on the same day: now +11.
    ['Australia/Sydney', '2026-10-04', '03:30', '2026-10-03T16:30:00.000Z'],
    // Southern-hemisphere autumn: clocks go BACK.
    ['Australia/Sydney', '2026-04-05', '02:30', '2026-04-04T16:30:00.000Z'],
    // Northern transitions, in both directions.
    ['Europe/London', '2026-03-29', '00:30', '2026-03-29T00:30:00.000Z'],
    ['Europe/London', '2026-10-25', '01:30', '2026-10-25T01:30:00.000Z'],
    ['America/Boise', '2026-03-08', '00:30', '2026-03-08T07:30:00.000Z'],
    // A half-hour offset with no DST at all — the launch market, which must not regress.
    ['Asia/Kolkata', '2026-10-04', '00:30', '2026-10-03T19:00:00.000Z'],
    ['Asia/Kolkata', '2026-06-15', '10:30', '2026-06-15T05:00:00.000Z'],
  ])('%s %s %s', (zone, date, time, expectedIso) => {
    const r = roundTrips(zone, date, time);
    expect(r.iso).toBe(expectedIso);
    // The two that actually matter to an operator: the clock time they typed, on the day
    // they typed it against.
    expect(r.time).toBe(time);
    expect(r.date).toBe(date);
  });
});

describe('the hour that does not exist', () => {
  /*
    On a spring-forward day the clock jumps 02:00 -> 03:00, so 02:30 never happens. No
    instant reads back as 02:30, and there is no correct answer — only a least-bad one.

    Returning the instant the clock jumps TO is the convention scheduling software uses, and
    it is better than throwing: refusing to save would strand an operator who picked a time
    that looks perfectly ordinary in a dropdown.
  */
  it.each([
    ['Australia/Sydney', '2026-10-04', '02:30', '03:30'],
    ['Europe/London', '2026-03-29', '01:30', '02:30'],
    ['America/Boise', '2026-03-08', '02:30', '03:30'],
  ])('%s %s %s resolves forward rather than failing', (zone, date, time, expectedLocal) => {
    const r = roundTrips(zone, date, time);
    expect(r.time).toBe(expectedLocal);
    // Crucially it stays on the intended DAY. Landing on the previous day is the bug.
    expect(r.date).toBe(date);
  });

  it('never throws for a skipped time', () => {
    expect(() => zonedWallClockToInstant('2026-03-29', '01:15', 'Europe/London')).not.toThrow();
  });
});

describe('the ambiguous hour', () => {
  /*
    On a fall-back day 01:30 happens TWICE. Either instant is defensible; what matters is
    that one is chosen deterministically and that it reads back as 01:30 on the right day,
    rather than drifting to 00:30 or to the previous date.
  */
  it.each([
    ['Europe/London', '2026-10-25', '01:30'],
    ['Australia/Sydney', '2026-04-05', '02:30'],
    ['America/Boise', '2026-11-01', '01:30'],
  ])('%s %s %s picks one instant and round-trips', (zone, date, time) => {
    const r = roundTrips(zone, date, time);
    expect(r.time).toBe(time);
    expect(r.date).toBe(date);
    // Deterministic: the same input gives the same instant every time.
    expect(zonedWallClockToInstant(date, time, zone).toISOString()).toBe(r.iso);
  });
});

describe('every day around a transition, not just the transition itself', () => {
  /*
    A sweep, because the single-pass bug was invisible on the transition date for some
    times and visible for others. Checking one clock time on one day would have missed it.
  */
  it.each(['Australia/Sydney', 'Europe/London', 'America/Boise', 'Asia/Kolkata'])(
    '%s round-trips every hour across its spring transition week',
    (zone) => {
      const start = zone === 'Australia/Sydney' ? '2026-10-01' : '2026-03-26';
      const failures: string[] = [];
      for (let d = 0; d < 7; d++) {
        const day = new Date(new Date(`${start}T00:00:00Z`).getTime() + d * 86_400_000)
          .toISOString()
          .slice(0, 10);
        for (let h = 0; h < 24; h++) {
          const time = `${String(h).padStart(2, '0')}:30`;
          const r = roundTrips(zone, day, time);
          // A skipped hour legitimately moves forward; it must never move to another DAY.
          if (r.date !== day) failures.push(`${day} ${time} -> ${r.date} ${r.time}`);
        }
      }
      expect(failures).toEqual([]);
    },
  );
});
