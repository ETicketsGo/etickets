import type { LocationValue, Venue } from '@eticketsgo/web-kit';

/**
 * The fields that define a venue, in ONE place.
 *
 * -- WHY THIS COMPONENT EXISTS ------------------------------------------------------------
 * A venue could be created from three screens, and each built its own payload by hand:
 *
 *   /organizer/venues        name, city, country, region, timezone, address, capacity
 *   /organizer/events/new    name, city, country, region, timezone, capacity   (NO address)
 *   /organizer/onboarding    name, city, country, capacity   (NO region, NO timezone)
 *
 * So the same action produced three different objects. A venue created while making an event
 * had no street address and no way to add one from that screen; one created by the onboarding
 * sample silently took the default timezone, which is Asia/Kolkata - wrong for every organizer
 * outside India, and a venue's timezone is what every showtime on its public listing is
 * rendered in.
 *
 * None of that is visible to the organizer. They filled in "the venue form" and got a
 * different venue depending on which door they came through.
 */

/** Everything a venue is, as the API takes it. One shape, whoever is asking. */
export interface VenueDraft {
  name: string;
  city: string;
  address: string;
  capacity: string;
  where: LocationValue;
}

export function emptyVenueDraft(): VenueDraft {
  return {
    name: '',
    city: '',
    address: '',
    capacity: '',
    where: { country: '', region: '', timezone: '' },
  };
}

/** A draft taken from an existing venue, for editing it. */
export function venueDraftFrom(v: Venue): VenueDraft {
  return {
    name: v.name,
    city: v.city,
    address: v.address ?? '',
    capacity: v.capacity != null ? String(v.capacity) : '',
    where: { country: v.country ?? '', region: v.region ?? '', timezone: v.timezone ?? '' },
  };
}

/**
 * The one payload every caller sends. No screen gets to decide which fields a venue has.
 *
 * `region` is sent as `''` rather than omitted when cleared, so an organizer can unset a state
 * they picked by mistake - it is a dropdown with an explicit "Not specified", which is somebody
 * answering rather than not answering. `address` is the opposite: blank means not filled in.
 */
export function venuePayload(draft: VenueDraft) {
  return {
    name: draft.name.trim(),
    city: draft.city.trim(),
    // Absent means absent. Writing 'India' for a blank answer made every unanswered venue
    // claim India, and through it INR - so pricing and checkout succeeded in the launch
    // market's currency instead of refusing until somebody said where the venue is.
    country: draft.where.country.trim() || undefined,
    region: draft.where.region.trim(),
    timezone: draft.where.timezone || undefined,
    address: draft.address.trim() || undefined,
    capacity: draft.capacity ? Number(draft.capacity) : undefined,
  };
}

/** The problems a venue draft has, keyed by field. Same rules wherever it is filled in. */
export function venueProblems(draft: VenueDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (draft.name.trim().length < 2) e.name = 'Give the venue a name.';
  if (!draft.city.trim()) e.city = 'Which city is it in?';
  if (draft.capacity && !Number.isFinite(Number(draft.capacity))) {
    e.capacity = 'Capacity must be a number.';
  }
  return e;
}
