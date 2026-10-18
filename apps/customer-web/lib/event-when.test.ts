import { afterEach, describe, expect, it } from 'vitest';
import { dateTime, zoneAbbrev } from '@eticketsgo/web-kit';
import { eventZone, sessionZone, summaryZone, venueWhenParts, whenWithZone } from './event-when';

describe('whenWithZone', () => {
  it('names the venue zone after the time', () => {
    const text = whenWithZone('2026-11-07T14:00:00Z', 'Asia/Kolkata', { dateTime, zoneAbbrev });
    expect(text).toMatch(/7:30 pm \(IST\)$|7:30 pm \(GMT\+5:30\)$/);
  });

  it('adds nothing when the venue has no zone', () => {
    const text = whenWithZone('2026-11-07T14:00:00Z', undefined, { dateTime, zoneAbbrev });
    expect(text).not.toContain('(');
  });
});

/*
  The storefront's show times, rendered by a reader in Denver and by one in Kolkata.

  The defect: in a Denver browser the event page printed a show as "Wed 28 Oct 2026, 10:04 pm"
  while its confirmation printed "Thu 29 Oct 2026, 9:34 am GMT+5:30". Each case below renders
  the SAME string in both readers' zones, and it is the venue's.
*/
describe('show times are on the venue clock in every reader zone', () => {
  const SHOW = '2026-10-29T04:04:00Z'; // 9:34 am in India; 10:04 pm the day before in Denver
  const READERS = ['America/Denver', 'Asia/Kolkata'];
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  /** One line the way the event page, seat page and confirmation print it. */
  const line = (zone: string | undefined) => {
    const w = venueWhenParts(SHOW, zone, 'en-IN', zoneAbbrev);
    return `${w.day}, ${w.time} ${w.zone}`;
  };
  const inEachReader = (render: () => string) =>
    READERS.map((tz) => {
      process.env.TZ = tz;
      return render();
    });

  it('event page: a venue row with no zone uses its country, as the booking does', () => {
    // What the QA API sends today for a venue never asked its zone.
    const event = { venue: { timezone: null, country: 'India' } };
    const session: { timeZone?: string | null } = {};
    const [denver, kolkata] = inEachReader(() => line(sessionZone(session, event)));
    expect(denver).toBe(kolkata);
    expect(denver).toMatch(/^Thu 29 Oct 2026, 9:34 am (IST|GMT\+5:30)$/);
  });

  it("event page: the session's own zone wins over the venue row (a cinema screen)", () => {
    const event = {
      timeZone: 'America/Denver',
      venue: { timezone: 'America/Denver', country: 'US' },
    };
    const session = { startsAt: SHOW, timeZone: 'Asia/Kolkata' };
    const [denver, kolkata] = inEachReader(() => line(sessionZone(session, event)));
    expect(denver).toBe(kolkata);
    expect(denver).toMatch(/^Thu 29 Oct 2026, 9:34 am/);
  });

  it('seat page: a summary with no zone uses the venue country', () => {
    const summary = { timeZone: null, venue: { country: 'India' } };
    const [denver, kolkata] = inEachReader(() => line(summaryZone(summary)));
    expect(denver).toBe(kolkata);
    expect(denver).toMatch(/^Thu 29 Oct 2026, 9:34 am/);
  });

  it('cards: the date is the venue day, not the reader day', () => {
    const card = { venue: { timezone: null, country: 'India' } };
    const [denver, kolkata] = inEachReader(() => dateTime(SHOW, undefined, eventZone(card)));
    expect(denver).toBe(kolkata);
    expect(denver).toMatch(/^29 Oct 2026/);
  });

  it('an unknown zone is the reader clock, and says so', () => {
    // Several zones, none stored: nothing to guess with. The time is named as the reader's.
    const event = { venue: { timezone: null, country: 'United States' } };
    expect(sessionZone({}, event)).toBeUndefined();
    process.env.TZ = 'America/Denver';
    expect(line(undefined)).toMatch(/^Wed 28 Oct 2026, 10:04 pm (MDT|GMT-6)$/);
  });
});
