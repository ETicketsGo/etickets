'use client';

import { Input, Select, LocationFields, type Venue } from '@eticketsgo/web-kit';
import { type VenueDraft } from './venue-draft';

/*
  The pure parts - the payload, the validation and the draft shape - live in `venue-draft.ts`
  with no JSX in it, so they can be tested without a React renderer. That split is why the
  rules every screen shares are the easiest thing in this file to assert.
*/
export * from './venue-draft';

/**
 * The venue form body, without a card, heading or submit button, so each screen can place it
 * in its own layout while the FIELDS stay identical.
 *
 * Capacity is deliberately optional and labelled as the whole site: a venue's capacity is not
 * the thing tickets are sold against - a space's layout is - and presenting it as required
 * invites a number that contradicts the seating.
 */
export function VenueFields({
  draft,
  onChange,
  errors = {},
  disabled = false,
}: {
  draft: VenueDraft;
  onChange: (next: VenueDraft) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  const set = <K extends keyof VenueDraft>(key: K, value: VenueDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <div className="space-y-4">
      <Input
        id="venue-name"
        label="Venue name"
        value={draft.name}
        onChange={(e) => set('name', e.target.value)}
        error={errors.name}
        disabled={disabled}
      />
      <LocationFields
        value={draft.where}
        onChange={(where) => set('where', where)}
        disabled={disabled}
      />
      <Input
        id="venue-city"
        label="City"
        value={draft.city}
        onChange={(e) => set('city', e.target.value)}
        error={errors.city}
        disabled={disabled}
      />
      <Input
        id="venue-address"
        label="Street address"
        hint="Just the street and area. The city and country are set above."
        value={draft.address}
        onChange={(e) => set('address', e.target.value)}
        disabled={disabled}
      />
      <Input
        id="venue-capacity"
        label="Total capacity (optional)"
        hint="The whole site. What you actually sell comes from each space's seating."
        inputMode="numeric"
        value={draft.capacity}
        onChange={(e) => set('capacity', e.target.value)}
        error={errors.capacity}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * Where a space is, shown rather than asked.
 *
 * -- THE DEFECT THIS REPLACES -------------------------------------------------------------
 * Creating a space asked for City, Street address, Latitude and Longitude, and THEN asked
 * "Which venue is this room in?" - in that order. So an organizer entered a location, then
 * named the venue that already had one, and nothing reconciled the two. It is the reason a
 * space inside a venue could appear to be somewhere else: it genuinely could, because it
 * carried its own address and nothing said which one won.
 *
 * A space is a physical area INSIDE a venue. It is where the venue is. Showing that is the
 * honest control; asking again is an invitation to disagree with yourself.
 */
export function InheritedVenueLocation({ venue }: { venue: Venue }) {
  const line = [venue.city, venue.region, venue.country].filter(Boolean).join(', ');
  return (
    <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
      <p className="text-caption font-semibold uppercase tracking-wide text-text-secondary">
        Location
      </p>
      <p className="mt-1 font-medium text-text-primary">{venue.name}</p>
      {venue.address ? (
        <p className="text-[0.9375rem] text-text-secondary">{venue.address}</p>
      ) : null}
      <p className="text-[0.9375rem] text-text-secondary">{line}</p>
      <p className="mt-1 text-caption text-text-muted">
        {venue.timezone} &middot; inherited from the venue
      </p>
    </div>
  );
}

/** Venue picker for a screen that creates something INSIDE a venue. */
export function VenuePicker({
  venues,
  value,
  onChange,
  allowNew = true,
  label = 'Which venue is this in?',
}: {
  venues: Venue[];
  value: string;
  onChange: (venueId: string) => void;
  allowNew?: boolean;
  label?: string;
}) {
  return (
    <Select id="venueId" label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNew ? <option value="">Create a new venue for it</option> : null}
      {venues.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name} &mdash; {v.city}
        </option>
      ))}
    </Select>
  );
}
