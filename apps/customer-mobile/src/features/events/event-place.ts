/**
 * Where an event happens, in words, the same rule as the website (customer-web
 * lib/event-place.ts).
 *
 * An ONLINE event still carries a venue: the organizer's placeholder for the stream, with a
 * city only so discovery can list it. Printing that venue, and offering directions to it,
 * sent people to a place where nothing happens. Online events read "Online"; a HYBRID one
 * reads as its venue plus online.
 */
export interface Placed {
  venue: { name: string; city: string };
  attendanceMode?: string | null;
}

export const ONLINE = 'Online';

export function isOnlineOnly(event: { attendanceMode?: string | null }): boolean {
  return event.attendanceMode === 'ONLINE';
}

export function eventPlace(event: Placed): { full: string; name: string; city: string } {
  if (isOnlineOnly(event)) return { full: ONLINE, name: ONLINE, city: '' };
  const full = `${event.venue.name}, ${event.venue.city}`;
  return {
    full: event.attendanceMode === 'HYBRID' ? `${full} + ${ONLINE}` : full,
    name: event.venue.name,
    city: event.venue.city,
  };
}
