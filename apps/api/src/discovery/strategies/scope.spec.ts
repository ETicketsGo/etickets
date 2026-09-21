import { venueInScope } from './scope';

/**
 * The one place rule every Explore section uses.
 *
 * Explore was the page the country rule never reached: each section filtered by `ctx.city`
 * alone, so a visitor scoped to a country with no city chosen got sections filtered by
 * nothing, and the owner saw Hyderabad, Mumbai, Boise and Meridian from the United States.
 */
describe('venueInScope', () => {
  it('filters by the chosen city', () => {
    expect(venueInScope({ city: 'Hyderabad' })).toEqual({
      city: { equals: 'Hyderabad', mode: 'insensitive' },
    });
  });

  it('filters by the country when no city is chosen, in every spelling', () => {
    // The scope is an ISO code; a venue carries whatever its organizer typed.
    const where = venueInScope({ country: 'IN' }) as { country: { in: string[] } };
    expect(where.country.in).toEqual(expect.arrayContaining(['in', 'india']));
  });

  it('lets the city win when both are present', () => {
    // A US visitor who searched for and picked Hyderabad must get Hyderabad, not a
    // Hyderabad in America and an empty page.
    expect(venueInScope({ city: 'Hyderabad', country: 'US' })).toEqual({
      city: { equals: 'Hyderabad', mode: 'insensitive' },
    });
  });

  it('filters by nothing only when we could not place the visitor at all', () => {
    expect(venueInScope({})).toEqual({});
  });
});
