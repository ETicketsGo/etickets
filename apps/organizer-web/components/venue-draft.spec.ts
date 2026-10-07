import { describe, it, expect } from 'vitest';
import { venuePayload, venueProblems, emptyVenueDraft, type VenueDraft } from './venue-draft';

/**
 * One venue, whichever door the organizer came through.
 *
 * -- THE DEFECT THIS PINS ------------------------------------------------------------------
 * A venue could be created from three screens, and each built its own payload by hand:
 *
 *   /organizer/venues        name, city, country, region, timezone, address, capacity
 *   /organizer/events/new    name, city, country, region, timezone, capacity   (NO address)
 *   /organizer/onboarding    name, city, country, capacity   (NO region, NO timezone)
 *
 * So the same action produced three different objects, and nothing on screen said so. A venue
 * created while making an event had no street address; one created by onboarding silently took
 * the default timezone - Asia/Kolkata - which is what every showtime on a public listing is
 * rendered in, and wrong for every organizer outside India.
 *
 * These tests are on the SHARED function all three now call, so the shapes cannot drift apart
 * again without one of them failing.
 */

const draft = (over: Partial<VenueDraft> = {}): VenueDraft => ({
  ...emptyVenueDraft(),
  name: 'ExtraMile Arena',
  city: 'Boise',
  address: '1910 University Dr',
  capacity: '12450',
  where: { country: 'United States', region: 'Idaho', timezone: 'America/Boise' },
  ...over,
});

describe('the canonical venue payload', () => {
  it('carries every field a venue has, from one place', () => {
    expect(venuePayload(draft())).toEqual({
      name: 'ExtraMile Arena',
      city: 'Boise',
      country: 'United States',
      region: 'Idaho',
      timezone: 'America/Boise',
      address: '1910 University Dr',
      capacity: 12450,
    });
  });

  it('keeps the address, which event creation used to drop', () => {
    expect(venuePayload(draft()).address).toBe('1910 University Dr');
  });

  it('keeps the timezone, which onboarding used to drop', () => {
    /*
      The one with real consequences. Without it the venue takes the schema default, and a
      Boise arena would render every showtime in Asia/Kolkata.
    */
    expect(venuePayload(draft()).timezone).toBe('America/Boise');
  });

  it('trims, so a trailing space does not become part of the name', () => {
    const p = venuePayload(draft({ name: '  Main Hall  ', city: '  Hyderabad ' }));
    expect(p.name).toBe('Main Hall');
    expect(p.city).toBe('Hyderabad');
  });

  it('sends a cleared region as empty string, so it can be unset', () => {
    /*
      Deliberately NOT `undefined`. The region control has an explicit "Not specified", so a
      blank is somebody answering - and an omitted field would leave the old value in place.
      `address` is the opposite: blank there means "not filled in", so it is omitted.
    */
    const p = venuePayload(draft({ where: { country: 'India', region: '', timezone: '' } }));
    expect(p.region).toBe('');
    expect(p.timezone).toBeUndefined();
  });

  it('omits a blank address rather than writing an empty one', () => {
    expect(venuePayload(draft({ address: '   ' })).address).toBeUndefined();
  });

  it('omits capacity when not given, because a venue need not state one', () => {
    // What is actually sold comes from a space's layout, not from this number.
    expect(venuePayload(draft({ capacity: '' })).capacity).toBeUndefined();
  });

  it('sends a number for capacity, not the typed string', () => {
    expect(venuePayload(draft({ capacity: '500' })).capacity).toBe(500);
  });
});

describe('what makes a venue draft incomplete', () => {
  it('needs a name and a city', () => {
    const problems = venueProblems(emptyVenueDraft());
    expect(problems.name).toBeDefined();
    expect(problems.city).toBeDefined();
  });

  it('accepts a complete draft', () => {
    expect(venueProblems(draft())).toEqual({});
  });

  it('rejects a capacity that is not a number', () => {
    expect(venueProblems(draft({ capacity: 'lots' })).capacity).toBeDefined();
  });

  it('allows no capacity at all', () => {
    expect(venueProblems(draft({ capacity: '' })).capacity).toBeUndefined();
  });
});
