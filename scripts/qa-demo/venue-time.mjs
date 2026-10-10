/**
 * Wall-clock time at a venue, as an instant.
 *
 * The dataset says "18:30 on 14 November in Bengaluru" because that is how an organizer
 * thinks; the API takes instants. Adding a fixed offset would be right for India and wrong
 * for Boise, which changes its clocks on 1 November - inside the demo's date range.
 */

/** Minutes the zone is ahead of UTC at a given instant. */
function zoneOffsetMinutes(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** "2026-11-14" + "18:30" in `timeZone`, as a Date. Two passes settle a DST boundary. */
export function venueTimeToInstant(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let instant = new Date(wall);
  for (let i = 0; i < 2; i++) {
    instant = new Date(wall - zoneOffsetMinutes(instant, timeZone) * 60000);
  }
  return instant;
}
