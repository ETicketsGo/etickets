'use client';

import { useTranslations } from 'next-intl';

interface Placed {
  venue: { name: string; city: string };
  attendanceMode?: 'IN_PERSON' | 'ONLINE' | 'HYBRID' | string | null;
}

/**
 * Where an event happens, as cards and the event page print it.
 *
 * An ONLINE event's venue holds its country and time zone, not a place: printed as a venue it
 * read "Online, Online" on cards and "COMMUNITY / ONLINE" in the eyebrow. It says "Online" once
 * now. A HYBRID event names its venue and says it is online too.
 */
export function eventPlace(event: Placed, online: string): { full: string; city: string } {
  if (event.attendanceMode === 'ONLINE') return { full: online, city: online };
  const full = `${event.venue.name}, ${event.venue.city}`;
  return {
    full: event.attendanceMode === 'HYBRID' ? `${full} + ${online}` : full,
    city: event.venue.city,
  };
}

/** `eventPlace` with the reader's word for "Online". */
export function useEventPlace() {
  const t = useTranslations('common');
  return (event: Placed) => eventPlace(event, t('online'));
}
