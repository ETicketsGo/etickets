import { GRID_LAYOUT_MAX_SEATS, checkGridLayoutLimit } from './grid-layout-limit';

/**
 * A room big enough to need blocks must be drawn in blocks.
 *
 * -- THE FAILURE THIS PREVENTS ------------------------------------------------------------
 * A GRID layout is read in one go: every seat, every time a buyer opens the map. Measured on
 * a real database, that is 73 KB at 500 seats and 3,667 KB at 25,000. The same 25,000-seat
 * arena read as SECTIONED is 4 KB for the overview and 87 KB for one block.
 *
 * Nothing stopped an arena being created as a grid. It would have worked in every test, been
 * fast on the server, and been 3.6 MB on a buyer's phone at the moment they were paying.
 */
describe('a grid layout has a size limit, and a sectioned one does not', () => {
  it('lets an ordinary cinema through', () => {
    // The case that must not break: a big single screen is a few hundred seats.
    expect(checkGridLayoutLimit('GRID', 400).ok).toBe(true);
  });

  it('refuses an arena drawn as one grid', () => {
    const verdict = checkGridLayoutLimit('GRID', 25_000);
    expect(verdict.ok).toBe(false);
    // Says what to do instead, not just that it was refused.
    expect(verdict.reason).toMatch(/blocks/i);
    expect(verdict.reason).toMatch(/25,000/);
  });

  it('never limits a sectioned layout, whatever its size', () => {
    /*
      The point of the rule. A sectioned arena is fine BECAUSE it is read a block at a time,
      so applying a size limit to it would refuse the very shape the limit exists to push
      people towards.
    */
    expect(checkGridLayoutLimit('SECTIONED', 25_000).ok).toBe(true);
    expect(checkGridLayoutLimit('SECTIONED', 250_000).ok).toBe(true);
  });

  it('is inclusive at the boundary', () => {
    // Exactly the limit is allowed; one more is not. Stated because an off-by-one here
    // refuses a layout an organizer was told was acceptable.
    expect(checkGridLayoutLimit('GRID', GRID_LAYOUT_MAX_SEATS).ok).toBe(true);
    expect(checkGridLayoutLimit('GRID', GRID_LAYOUT_MAX_SEATS + 1).ok).toBe(false);
  });

  it('does not limit a layout whose kind is unknown', () => {
    /*
      Null means "not recorded", which is not the same as "a grid". Treating an absent kind
      as GRID would refuse to publish layouts that predate the column for no reason a person
      could act on.
    */
    expect(checkGridLayoutLimit(null, 25_000).ok).toBe(true);
    expect(checkGridLayoutLimit(undefined, 25_000).ok).toBe(true);
  });
});
