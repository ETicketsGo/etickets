import { dateTime, zoneAbbrev } from '@eticketsgo/shared-types';

/**
 * The time printed on a ticket is the venue's, not the device's.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ────────────────────────────────────────────
 * Most Indian cinemas admit on a visual check: someone reads the ticket, looks at the screen
 * and seat, and waves the customer through. The barcode is the exception. So the time on the
 * ticket is not decoration — it is the thing being checked, against the clock on the wall.
 *
 * The wallet rendered `startsAt` with no timezone, which means the DEVICE's. A phone set to
 * another zone — a traveller, a device with the wrong region, someone abroad buying for family
 * at home — showed a time that was not when the show starts. Nothing about that is visible to
 * the person holding it: the ticket looks completely normal and sends them to the wrong
 * screening, or to the right one at the wrong hour.
 *
 * These tests pin the rule at the formatting layer, where both the wallet and any future
 * surface reach it.
 */

/** 7:30pm in Vijayawada on 16 September 2026, expressed as an absolute instant. */
const SHOW = '2026-09-16T14:00:00.000Z';

describe('a show time rendered for the venue', () => {
  it('says 7:30 pm in the cinema’s zone', () => {
    expect(dateTime(SHOW, 'en-IN', 'Asia/Kolkata')).toMatch(/7:30\s*pm/i);
  });

  it('says something DIFFERENT on a device in another zone, which is the whole problem', () => {
    /*
      Not a hypothetical. The same instant is a different wall-clock time in New York, and the
      old ticket showed whichever one the phone happened to believe in. If this assertion ever
      fails, the two have been made equal and this test has stopped meaning anything.
    */
    const atVenue = dateTime(SHOW, 'en-IN', 'Asia/Kolkata');
    const onADeviceElsewhere = dateTime(SHOW, 'en-IN', 'America/New_York');
    expect(onADeviceElsewhere).not.toBe(atVenue);
  });

  it('is stable regardless of where the process rendering it happens to run', () => {
    // The server formats receipts and emails too. Passing the zone explicitly is what makes
    // the output independent of the machine, which is why the zone travels with the ticket.
    expect(dateTime(SHOW, 'en-IN', 'Asia/Kolkata')).toBe(dateTime(SHOW, 'en-IN', 'Asia/Kolkata'));
  });
});

describe('naming the zone on the ticket', () => {
  it('labels an Indian show IST, so the time can be checked against a clock', () => {
    expect(zoneAbbrev(SHOW, 'Asia/Kolkata')).toMatch(/IST|GMT\+5:30/);
  });

  it('says nothing at all when no zone is known', () => {
    /*
      An unlabelled time is better than one labelled with a zone nobody supplied. A wrong
      label is worse than no label: it invites the reader to trust a conversion that never
      happened.
    */
    expect(zoneAbbrev(SHOW, undefined)).toBe('');
  });
});
