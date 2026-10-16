import { zonedWallClockToInstant } from '../shows/shows.service';

/**
 * Booking states that mean somebody holds - or is paying for - a ticket that names a time.
 *
 * A refunded, cancelled or expired booking names nothing anybody will turn up for, so it does
 * not lock the clock. A pending payment does: that buyer is at a checkout right now, looking at
 * the time on the page.
 */
export const SOLD_BOOKING_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PARTIALLY_REFUNDED',
  'DISPUTED',
] as const;

/**
 * The same wall-clock time in another zone.
 *
 * An organizer who typed "19:00" for a venue saved on the wrong clock meant 19:00 AT THE
 * VENUE. Correcting the venue's zone must not turn that into 17:00, so a session nobody has
 * bought keeps its local time: the instant is re-resolved in the new zone. Seconds and
 * milliseconds ride along unchanged.
 */
export function keepWallClock(instant: Date, fromZone: string, toZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: fromZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const moved = zonedWallClockToInstant(date, `${hour}:${get('minute')}`, toZone);
  const subMinute = instant.getTime() % 60_000;
  return new Date(moved.getTime() + (subMinute < 0 ? subMinute + 60_000 : subMinute));
}
