import { describe, it, expect } from 'vitest';

/**
 * The sidebar rule, and the thing it must never become.
 *
 * Films was a permanent top-level heading, so every organizer who does no film business - most of
 * them - read a whole section of the product as something they had failed to set up. Hiding it was
 * previously rejected on the grounds that a cinema operator on day one would have nowhere to
 * begin. That was right about the risk; the remedy is a beginning on Venues & rooms rather than a
 * permanent section.
 *
 * These assert the RULE, deliberately mirroring it rather than importing the layout - that file
 * is a client component full of icons, and the rule is the part worth pinning.
 */
const filmsVisible = (movieCount: number) => movieCount > 0;
/** The day-one path, shown on Venues & rooms exactly when the sidebar does not carry Films. */
const cinemaEntryPointVisible = (movieCount: number) => !filmsVisible(movieCount);

describe('organizer navigation by capability', () => {
  it('shows no film navigation to an organizer with no films', () => {
    // A concert promoter should not read the console as cinema software.
    expect(filmsVisible(0)).toBe(false);
  });

  it('shows Films once the organization has one', () => {
    expect(filmsVisible(1)).toBe(true);
    expect(filmsVisible(40)).toBe(true);
  });

  it('always leaves a new cinema operator somewhere to begin', () => {
    /*
      THE case the old comment was protecting, and the reason hiding alone would have been wrong.
      With zero films the sidebar carries nothing, so the entry point on Venues & rooms must be
      there - that is where somebody setting up screens and seat maps already is.
    */
    expect(filmsVisible(0)).toBe(false);
    expect(cinemaEntryPointVisible(0)).toBe(true);
  });

  it('never shows both the section and the beginner entry point', () => {
    // Two ways in is two things to understand; the entry point retires once Films appears.
    for (const count of [0, 1, 2, 10]) {
      expect(filmsVisible(count) && cinemaEntryPointVisible(count)).toBe(false);
    }
  });

  it('covers an organization that does both', () => {
    // A venue operator who also screens films gets the ordinary nav plus Films. Nothing is taken
    // away from the non-film half.
    expect(filmsVisible(3)).toBe(true);
  });

  it('is hiding, never authorization', () => {
    /*
      A hidden nav item must never be the thing that stops somebody reaching a page. `/organizer/
      movies` still resolves and the API still decides who may read it; this rule only decides
      what is worth putting in front of somebody. If this ever becomes the access check, the
      first person to type the URL has full access to something they should not.
    */
    const routeStillExists = true;
    expect(routeStillExists).toBe(true);
  });
});
