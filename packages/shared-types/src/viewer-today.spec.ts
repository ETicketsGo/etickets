import { describe, expect, it } from 'vitest';
import { viewerTimeZone, viewerToday, viewerZoneLabel } from './viewer-today';

/*
  One fixed reference instant, injected - never the machine's clock - so these pass on any day and
  in any zone the test runner happens to sit in. It is a UTC midnight in October, when Denver is on
  daylight time (UTC-6) and Kolkata is UTC+5:30 all year.

  Expected days are worked out from fixed offsets with UTC arithmetic, independently of the code
  under test, rather than written out as date strings.
*/
const REFERENCE = Date.UTC(2026, 9, 10);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const OFFSET_HOURS: Record<string, number> = {
  UTC: 0,
  'America/Denver': -6,
  'Asia/Kolkata': 5.5,
};

/** The calendar day an instant falls on at a fixed offset, by arithmetic alone. */
function dayAtOffset(instant: number, offsetHours: number): string {
  return new Date(instant + offsetHours * HOUR).toISOString().slice(0, 10);
}

/** The instants around each of the three midnights, one minute either side. */
const INSTANTS: Record<string, number> = {
  'just before UTC midnight': REFERENCE - MINUTE,
  'just after UTC midnight': REFERENCE + MINUTE,
  'just before Kolkata midnight': REFERENCE - 5.5 * HOUR - MINUTE,
  'just after Kolkata midnight': REFERENCE - 5.5 * HOUR + MINUTE,
  'just before Denver midnight': REFERENCE + 6 * HOUR - MINUTE,
  'just after Denver midnight': REFERENCE + 6 * HOUR + MINUTE,
};

describe('today on the viewer clock', () => {
  for (const [moment, instant] of Object.entries(INSTANTS)) {
    for (const [zone, offset] of Object.entries(OFFSET_HOURS)) {
      it(`is the ${zone} date ${moment}`, () => {
        const today = viewerToday(new Date(instant), zone);
        expect(today.day).toBe(dayAtOffset(instant, offset));
        expect(today.zone).toBe(zone);
      });
    }
  }

  it('changes day exactly at the viewer midnight, not at UTC midnight', () => {
    // The owner's report: 18:30 in Denver is already the next day in UTC.
    const evening = REFERENCE + 30 * MINUTE;
    expect(viewerToday(new Date(evening), 'America/Denver').day).toBe(
      dayAtOffset(REFERENCE - HOUR, 0),
    );
    expect(viewerToday(new Date(evening), 'UTC').day).toBe(dayAtOffset(REFERENCE, 0));
  });

  it('names the zone it used, with its short name at that instant', () => {
    const today = viewerToday(new Date(REFERENCE), 'America/Denver');
    expect(today.zoneShort).toBe('MDT');
    expect(viewerZoneLabel(today)).toBe('America/Denver (MDT)');
    expect(viewerZoneLabel(viewerToday(new Date(REFERENCE), 'UTC'))).toBe('UTC');
  });

  it('reports UTC rather than guessing when the zone is not a real one', () => {
    const today = viewerToday(new Date(REFERENCE - MINUTE), 'Mars/Olympus_Mons');
    expect(today.zone).toBe('UTC');
    expect(today.day).toBe(dayAtOffset(REFERENCE - MINUTE, 0));
  });

  it('names a zone the browser reports by its old name by the name the product uses', () => {
    const today = viewerToday(new Date(REFERENCE), 'Asia/Calcutta');
    expect(today.zone).toBe('Asia/Kolkata');
    expect(today.day).toBe(viewerToday(new Date(REFERENCE), 'Asia/Kolkata').day);
  });

  it('defaults to the zone the runtime reports', () => {
    expect(viewerToday(new Date(REFERENCE)).zone).toBe(viewerTimeZone());
  });
});
