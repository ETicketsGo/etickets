import { describe, expect, it } from 'vitest';
import { venueAddressLine, venueMapQuery } from './venue-address';

describe('venueAddressLine', () => {
  it('does not say the city twice', () => {
    /*
      The defect, exactly as a real listing showed it. The organizer typed the whole address
      into the one box labelled "Address", because that is what the word means, and the page
      appended the city and country it already held:

          Worli, Mumbai, MH, Mumbai, India
    */
    expect(
      venueAddressLine({
        address: 'Worli, Mumbai, MH',
        city: 'Mumbai',
        region: 'MH',
        country: 'India',
      }),
    ).toBe('Worli, Mumbai, MH, India');
  });

  it('leaves a state we do not hold alone, rather than guessing at it', () => {
    /*
      Observed on a real listing. The organizer typed "Worli, Mumbai, MH" and the venue has no
      `region` recorded, so only the city is known to be a repeat. The result is

          Worli, MH, Mumbai, India

      which puts the state before the city and is not how anybody would write it out. It is
      still the right answer: "MH" is a string in a free-text box, and the only way to know it
      is a state is to guess. Guessing is how a street called "India Gate" loses a word. The
      duplicate - the actual defect - is gone, and nothing has been deleted that we were not
      certain about.
    */
    expect(
      venueAddressLine({ address: 'Worli, Mumbai, MH', city: 'Mumbai', country: 'India' }),
    ).toBe('Worli, MH, Mumbai, India');
  });

  it('keeps a street that merely contains the city name', () => {
    /*
      The reason the rule matches whole comma-parts and never substrings. "Mumbai Road" is a
      real street in Pune, and deleting a word from somebody's address is worse than printing
      one twice - the reader cannot tell it happened.
    */
    expect(venueAddressLine({ address: 'Mumbai Road', city: 'Pune', country: 'India' })).toBe(
      'Mumbai Road, Pune, India',
    );
    expect(venueAddressLine({ address: 'India Gate', city: 'New Delhi', country: 'India' })).toBe(
      'India Gate, New Delhi, India',
    );
  });

  it('ignores case and stray spacing when matching', () => {
    // Typed by a person, so "mumbai" and "Mumbai  " are the same place.
    expect(venueAddressLine({ address: 'Worli,  mumbai ', city: 'Mumbai', country: 'India' })).toBe(
      'Worli, Mumbai, India',
    );
  });

  it('does not repeat a city that is also the state', () => {
    // Ordinary in India. "Delhi, Delhi, India" reads as a bug in our software rather than a
    // fact about the place.
    expect(venueAddressLine({ city: 'Delhi', region: 'Delhi', country: 'India' })).toBe(
      'Delhi, India',
    );
  });

  it('handles a venue with no street address at all', () => {
    // Every seeded venue is like this: `address` is optional and usually empty.
    expect(venueAddressLine({ city: 'Bengaluru', country: 'India' })).toBe('Bengaluru, India');
  });

  it('returns nothing to print when it knows nothing', () => {
    // An empty string rather than ", " or "undefined", so a caller can skip the element
    // instead of rendering its padding and separators around nothing.
    expect(venueAddressLine({})).toBe('');
    expect(venueAddressLine({ address: '  ', city: '', country: null })).toBe('');
  });

  it('drops the empty parts a trailing comma leaves behind', () => {
    expect(venueAddressLine({ address: 'Worli,,', city: 'Mumbai', country: 'India' })).toBe(
      'Worli, Mumbai, India',
    );
  });
});

describe('venueMapQuery', () => {
  it('leads with the name, which is what a map matches on', () => {
    expect(
      venueMapQuery({ name: 'NSCI Dome', address: 'Worli', city: 'Mumbai', country: 'India' }),
    ).toBe('NSCI Dome, Worli, Mumbai, India');
  });

  it('does not repeat a name the address already starts with', () => {
    expect(venueMapQuery({ name: 'NSCI Dome', address: 'NSCI Dome, Worli', city: 'Mumbai' })).toBe(
      'NSCI Dome, Worli, Mumbai',
    );
  });

  it('carries the same de-duplication as the printed line', () => {
    // A query that repeats the city scores worse, not better.
    expect(
      venueMapQuery({
        name: 'Phoenix Arena',
        address: 'Whitefield, Bengaluru',
        city: 'Bengaluru',
        country: 'India',
      }),
    ).toBe('Phoenix Arena, Whitefield, Bengaluru, India');
  });

  it('falls back to the address when there is no name', () => {
    expect(venueMapQuery({ city: 'Mumbai', country: 'India' })).toBe('Mumbai, India');
  });
});
