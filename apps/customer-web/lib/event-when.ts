/**
 * A show's start with the venue's zone named, the way the Sessions list and the ticket print it.
 *
 * The event page's key facts printed "7:30 pm" and nothing else, while the Sessions row under it
 * said "7:30 pm (IST)". A buyer planning a trip from another zone read the first one. The zone
 * is only named when the venue has one: guessing would put the reader's own clock in its place.
 */
export function whenWithZone(
  startsAt: string,
  zone: string | undefined,
  format: {
    dateTime: (iso: string, locale?: string, zone?: string) => string;
    zoneAbbrev: (iso: string, zone?: string) => string;
  },
): string {
  const text = format.dateTime(startsAt, undefined, zone);
  return zone ? `${text} (${format.zoneAbbrev(startsAt, zone)})` : text;
}
