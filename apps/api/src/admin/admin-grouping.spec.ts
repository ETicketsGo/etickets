import { GROUPABLE, GROUPING_SHAPES } from './admin-grouping.service';
import { GROUP_KEY_NONE, GROUP_SCOPES, groupScopeWhere } from './group-scope';

/**
 * The three tables that describe a grouping cannot drift apart.
 *
 * ── WHY THIS IS WORTH A TEST ───────────────────────────────────────────────────────
 * A grouping is declared in three places that TypeScript cannot relate to each other:
 * `GROUPABLE` says which groupings a queue offers, `GROUPING_SHAPES` holds the SQL that counts
 * them, and `GROUP_SCOPES` holds the Prisma `where` that narrows the list to one of them. They
 * are keyed by strings, so adding a grouping to one and forgetting the others compiles
 * perfectly.
 *
 * Each omission fails differently and all three are bad: a grouping in `GROUPABLE` with no shape
 * is an option in the dropdown that errors when chosen; a grouping with a shape and no scope is a
 * summary whose rows cannot be clicked; and a scope with no shape is dead code that looks like a
 * feature.
 */
describe('a grouping is declared consistently or not at all', () => {
  it('has something to check', () => {
    // Guard on the guard: empty tables would make every loop below pass vacuously.
    expect(Object.keys(GROUPABLE).length).toBe(6);
    expect(Object.keys(GROUPING_SHAPES).length).toBeGreaterThan(10);
  });

  it('gives every offered grouping a query and a scope', () => {
    const missing: string[] = [];
    for (const [resource, groupings] of Object.entries(GROUPABLE)) {
      for (const groupBy of groupings) {
        if (!GROUPING_SHAPES[`${resource}:${groupBy}`])
          missing.push(`SQL for ${resource}:${groupBy}`);
        if (!GROUP_SCOPES[resource]?.[groupBy]) missing.push(`scope for ${resource}:${groupBy}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('offers every query and scope it defines', () => {
    const orphans: string[] = [];
    const offered = new Set(
      Object.entries(GROUPABLE).flatMap(([r, gs]) => gs.map((g) => `${r}:${g}`)),
    );
    for (const pair of Object.keys(GROUPING_SHAPES)) {
      if (!offered.has(pair)) orphans.push(`SQL ${pair} is not offered`);
    }
    for (const [resource, builders] of Object.entries(GROUP_SCOPES)) {
      for (const groupBy of Object.keys(builders)) {
        if (!offered.has(`${resource}:${groupBy}`)) {
          orphans.push(`scope ${resource}:${groupBy} is not offered`);
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  /*
    The SQL and the `where` must select the SAME rows, and no test can prove that from the strings
    alone. What IS checkable is that they agree about which relation carries the grouping, because
    both spell it out: the shape's `from` names the joined table and the scope's object names the
    relation. A refund grouped by country that joined `Payment` in SQL and `booking` in Prisma
    would be two different questions wearing one label - which is exactly the defect that was in
    the first draft of this file, where three shapes joined a `Refund.paymentId` that has never
    existed.
  */
  it('reaches a country through the venue on every queue that offers it', () => {
    /*
      Collected as a list rather than asserted one at a time, so a failure names WHICH queue
      disagrees. `expect` here takes no message - this suite runs under jest, not vitest.
    */
    const wrong: string[] = [];
    for (const [resource, groupings] of Object.entries(GROUPABLE)) {
      if (!groupings.includes('country' as never)) continue;
      const sql = GROUPING_SHAPES[`${resource}:country`];
      const where = JSON.stringify(GROUP_SCOPES[resource].country('IN'));
      if (resource === 'organizers') {
        // The exception, and the reason this is asserted per resource: an organization's country
        // is its own column, because an organization has no venue.
        if (sql.key !== 'o."registeredCountry"') wrong.push(`${resource} SQL key ${sql.key}`);
        if (!where.includes('registeredCountry')) wrong.push(`${resource} scope ${where}`);
        continue;
      }
      if (!sql.from.includes('"Venue" v')) wrong.push(`${resource} SQL does not join Venue`);
      if (sql.key !== 'v.country') wrong.push(`${resource} SQL groups on ${sql.key}`);
      if (!where.includes('venue')) wrong.push(`${resource} scope is ${where}`);
    }
    expect(wrong).toEqual([]);
  });

  it('never reaches a refund through a payment', () => {
    /*
      `Refund` has `bookingId`, `organizationId` and `amountMinor`, and no `paymentId` at all. A
      join through `Payment` would not merely be wrong SQL - it would silently drop every refund
      of a booking that has no payment row, which is the cash-at-the-venue case.
    */
    const wrong: string[] = [];
    for (const groupBy of GROUPABLE.refunds) {
      const from = GROUPING_SHAPES[`refunds:${groupBy}`].from;
      if (from.includes('"Payment"')) wrong.push(`refunds:${groupBy} joins Payment`);
      if (!from.includes('"Booking" b ON b.id = r."bookingId"')) {
        wrong.push(`refunds:${groupBy} does not join Booking on bookingId`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('takes a refund currency from the booking, because a refund has none', () => {
    for (const groupBy of GROUPABLE.refunds) {
      expect(GROUPING_SHAPES[`refunds:${groupBy}`].money?.currency).toBe('b.currency');
    }
  });
});

describe('scoping a list to one group', () => {
  it('returns nothing at all when no grouping was asked for', () => {
    // `{}` and not `undefined`: the caller spreads the result into a `where`, and spreading
    // undefined is a TypeError.
    expect(groupScopeWhere('bookings', {})).toEqual({});
  });

  it('turns the sentinel into a null, so "Not recorded" is selectable', () => {
    expect(groupScopeWhere('organizers', { groupBy: 'country', groupKey: GROUP_KEY_NONE })).toEqual(
      {
        registeredCountry: null,
      },
    );
  });

  it('does not treat an empty key as the null group', () => {
    /*
      The empty string was the first spelling of the sentinel and had to be abandoned: the web
      client's `qs()` drops empty parameters, so it never left the browser. If it is ever accepted
      again the null group silently becomes "every row whose country is the empty string".
    */
    expect(groupScopeWhere('organizers', { groupBy: 'country', groupKey: '' })).toEqual({
      registeredCountry: '',
    });
  });

  it('refuses a grouping the resource does not support', () => {
    expect(() => groupScopeWhere('organizers', { groupBy: 'event', groupKey: 'x' })).toThrow(
      /cannot be grouped by event/,
    );
  });

  it('narrows nothing when a grouping is chosen but no group is', () => {
    /*
      The console's normal state, and the one this used to refuse with a 400. Choosing "Country"
      from the dropdown put a `groupBy` on every list request with no key yet, so the instant an
      operator picked a grouping the list underneath emptied itself. Only a browser showed it.
    */
    expect(groupScopeWhere('bookings', { groupBy: 'country' })).toEqual({});
  });

  it('refuses a key with no grouping, which selects nothing under any reading', () => {
    expect(() => groupScopeWhere('bookings', { groupKey: 'India' })).toThrow(/needs the groupBy/);
  });
});
