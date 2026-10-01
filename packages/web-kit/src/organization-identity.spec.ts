import { describe, it, expect } from 'vitest';
import {
  activeOrganizationSentenceName,
  humanRole,
  organizationIdentities,
  organizationIdentity,
  type OrganizationIdentityInput,
} from './organization-identity';

/**
 * The guarantee under test is "no two labels are ever the same", because the cost of a wrong
 * pick is silent: the organizer prices, publishes and settles against an entity they did not
 * intend, and every screen afterwards agrees with the mistake.
 */
const org = (
  o: Partial<OrganizationIdentityInput> & { id: string; name: string },
): OrganizationIdentityInput => ({
  slug: `slug-${o.id}`,
  ...o,
});

describe('organizationIdentities', () => {
  it('leaves a unique name alone', () => {
    // The ordinary case, and the reason the switcher stays readable: no qualifier is added when
    // the name already answers the question.
    const [a, b] = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', registeredCity: 'Hyderabad' }),
      org({ id: '2', name: 'P.V.R. Cinemas', registeredCity: 'Mumbai' }),
    ]);
    expect(a).toMatchObject({ primary: 'DeepTrics', secondary: null, label: 'DeepTrics' });
    expect(b.label).toBe('P.V.R. Cinemas');
  });

  it('tells two identically named organizations apart by city', () => {
    const [a, b] = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', registeredCity: 'Hyderabad' }),
      org({ id: '2', name: 'DeepTrics', registeredCity: 'Bengaluru' }),
    ]);
    expect(a.label).toBe('DeepTrics — Hyderabad');
    expect(b.label).toBe('DeepTrics — Bengaluru');
    expect(a.secondarySource).toBe('city');
  });

  it('is case- and space-insensitive about what counts as the same name', () => {
    const [a, b] = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', registeredCity: 'Hyderabad' }),
      org({ id: '2', name: '  deeptrics ', registeredCity: 'Bengaluru' }),
    ]);
    expect(a.secondary).toBe('Hyderabad');
    expect(b.secondary).toBe('Bengaluru');
  });

  it('skips a qualifier that is true but does not distinguish', () => {
    /*
      The point of the whole module. Both are in India, so the country is no answer - appending
      it would look like information and resolve nothing. The city differs, so the city is used.
    */
    const [a, b] = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', registeredCountry: 'India', registeredCity: 'Hyderabad' }),
      org({ id: '2', name: 'DeepTrics', registeredCountry: 'India', registeredCity: 'Bengaluru' }),
    ]);
    expect(a.secondarySource).toBe('city');
    expect(b.secondarySource).toBe('city');
  });

  it('rejects a city two of three namesakes share, and falls through', () => {
    // A qualifier has to differ from EVERY namesake, not just one of them.
    const ids = organizationIdentities([
      org({
        id: '1',
        name: 'DeepTrics',
        registeredCity: 'Hyderabad',
        legalName: 'DeepTrics Alpha',
      }),
      org({ id: '2', name: 'DeepTrics', registeredCity: 'Hyderabad', legalName: 'DeepTrics Beta' }),
      org({
        id: '3',
        name: 'DeepTrics',
        registeredCity: 'Bengaluru',
        legalName: 'DeepTrics Gamma',
      }),
    ]);
    expect(ids[0].secondarySource).toBe('legalName');
    expect(ids[1].secondarySource).toBe('legalName');
    // The third one's city is its own, so it may keep the better qualifier.
    expect(ids[2].secondarySource).toBe('city');
    expect(new Set(ids.map((i) => i.label)).size).toBe(3);
  });

  it('uses the role when nothing about the business differs', () => {
    const ids = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', myRole: 'ORGANIZER_OWNER' }),
      org({ id: '2', name: 'DeepTrics', myRole: 'CHECKIN_STAFF' }),
    ]);
    expect(ids[0].label).toBe('DeepTrics — organizer owner');
    expect(ids[1].label).toBe('DeepTrics — checkin staff');
  });

  it('falls back to the slug, which the schema guarantees is unique', () => {
    // Two rows identical in every human respect still get distinct labels. Never pretty, always
    // correct - and the reason this function cannot return a duplicate.
    const ids = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', slug: 'deeptrics' }),
      org({ id: '2', name: 'DeepTrics', slug: 'deeptrics-2' }),
    ]);
    expect(ids[0].secondarySource).toBe('slug');
    expect(ids.map((i) => i.label)).toEqual(['DeepTrics — deeptrics', 'DeepTrics — deeptrics-2']);
  });

  it('still uses a slug that happens to equal the name, because it is the guarantor', () => {
    /*
      Slugs are derived from names, so a one-word name matches its own slug. Skipping it as a
      "repeats the name" qualifier dropped the last candidate and put the duplicate labels back.
    */
    const ids = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', slug: 'deeptrics' }),
      org({ id: '2', name: 'DeepTrics', slug: 'deeptrics-2' }),
    ]);
    expect(ids.map((i) => i.label)).toEqual(['DeepTrics — deeptrics', 'DeepTrics — deeptrics-2']);
  });

  it('never returns two identical labels, however thin the data', () => {
    const ids = organizationIdentities([
      org({ id: '1', name: 'Same', slug: 'a' }),
      org({ id: '2', name: 'Same', slug: 'b' }),
      org({ id: '3', name: 'Same', slug: 'c' }),
      org({ id: '4', name: 'Other', slug: 'd' }),
    ]);
    expect(new Set(ids.map((i) => i.label)).size).toBe(4);
  });

  it('ignores a blank qualifier rather than rendering an empty one', () => {
    const ids = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', registeredCity: '   ', legalName: 'Alpha Pvt Ltd' }),
      org({ id: '2', name: 'DeepTrics', registeredCity: null, legalName: 'Beta Pvt Ltd' }),
    ]);
    expect(ids[0].secondary).toBe('Alpha Pvt Ltd');
    expect(ids[1].secondary).toBe('Beta Pvt Ltd');
  });

  it('skips a qualifier that merely repeats the name', () => {
    /*
      From real QA data: an organization called "DeepTrics" whose `legalName` is also
      "DeepTrics". Using it produced "DeepTrics — DeepTrics" - distinct from its namesake and
      unreadable. Falling through to the slug says the honest thing instead.
    */
    const ids = organizationIdentities([
      org({ id: '1', name: 'DeepTrics', slug: 'deeptrics-14a415', legalName: 'DeepTrics' }),
      org({ id: '2', name: 'DeepTrics', slug: 'deeptrics-66fee9' }),
    ]);
    expect(ids[0].label).toBe('DeepTrics — deeptrics-14a415');
    expect(ids[1].label).toBe('DeepTrics — deeptrics-66fee9');
    expect(ids.every((i) => i.secondarySource === 'slug')).toBe(true);
  });

  it('reproduces the whole QA organization list without a duplicate label', () => {
    /*
      The exact rows `GET /organizations` returns on QA, every field as the API sends it.

      An earlier version of this fixture was built from an abbreviated console dump that omitted
      `legalEntityType`, so it asserted both DeepTrics rows would fall through to their slugs. The
      rendered console disagreed - the first qualifies by entity type - and a test claiming to
      reproduce QA while describing something QA does not do is worse than no test at all.
    */
    const ids = organizationIdentities([
      org({
        id: '1',
        name: 'DeepTrics',
        slug: 'deeptrics-14a415',
        legalName: 'DeepTrics',
        legalEntityType: 'Private limited company',
        registeredCountry: 'India',
      }),
      org({
        id: '2',
        name: 'Music band',
        slug: 'music-band-cf8800',
        registeredCity: 'Hyderabad',
        registeredRegion: 'Telangana',
        legalName: 'DT',
        registeredCountry: 'India',
      }),
      org({
        id: '3',
        name: 'QA3 Gate Org 1789241921629',
        slug: 'qa3-gate-org-1789241921629-f03fee',
      }),
      org({ id: '4', name: 'P.V.R. Cinemas', slug: 'p-v-r-cinemas-86082a' }),
      org({ id: '5', name: 'Aswini k', slug: 'aswini-k-dee7d7' }),
      org({ id: '6', name: 'DeepTrics', slug: 'deeptrics-66fee9' }),
      org({
        id: '7',
        name: 'Bengaluru Live',
        slug: 'bengaluru-live',
        registeredCity: 'Bengaluru',
        legalName: 'Bengaluru Live Entertainment Pvt Ltd',
        registeredCountry: 'India',
      }),
    ]);
    expect(new Set(ids.map((i) => i.label)).size).toBe(7);
    /*
      Only the two ambiguous ones are qualified; the other five read exactly as they did before
      this change. The pair is asymmetric - one has an entity type to offer and the other has
      nothing at all - and that asymmetry is the data telling the truth about itself.
    */
    expect(ids.filter((i) => i.secondary !== null).map((i) => i.label)).toEqual([
      'DeepTrics — Private limited company',
      'DeepTrics — deeptrics-66fee9',
    ]);
  });

  it('keeps the input order, so a caller can zip it against its own list', () => {
    const ids = organizationIdentities([
      org({ id: 'x', name: 'Zeta' }),
      org({ id: 'y', name: 'Alpha' }),
    ]);
    expect(ids.map((i) => i.id)).toEqual(['x', 'y']);
  });
});

describe('organizationIdentity', () => {
  it('works whether or not the organization is already in the list', () => {
    const a = org({ id: '1', name: 'DeepTrics', registeredCity: 'Hyderabad' });
    const b = org({ id: '2', name: 'DeepTrics', registeredCity: 'Bengaluru' });
    expect(organizationIdentity(a, [a, b]).secondary).toBe('Hyderabad');
    // Passing a list that omits it must not silently report it as unambiguous.
    expect(organizationIdentity(a, [b]).secondary).toBe('Hyderabad');
  });
});

describe('activeOrganizationSentenceName', () => {
  it('names the organization plainly when the name is unique', () => {
    const a = org({ id: '1', name: 'DeepTrics' });
    expect(activeOrganizationSentenceName(a, [a])).toBe('DeepTrics');
  });

  it('always carries the qualifier, even where a switcher would not', () => {
    /*
      A confirmation is a different risk from a dropdown: a mis-read list costs a moment, a
      settlement against the wrong entity is not something the organizer can take back.
    */
    const a = org({ id: '1', name: 'DeepTrics', registeredCity: 'Hyderabad' });
    const b = org({ id: '2', name: 'DeepTrics', registeredCity: 'Bengaluru' });
    expect(activeOrganizationSentenceName(a, [a, b])).toBe('DeepTrics (Hyderabad)');
  });
});

describe('humanRole', () => {
  it('matches the wording the invitation page already uses', () => {
    expect(humanRole('ORGANIZER_OWNER')).toBe('organizer owner');
    expect(humanRole('CHECKIN_STAFF')).toBe('checkin staff');
  });

  it('is empty for a platform administrator, who has no organization role', () => {
    expect(humanRole(null)).toBe('');
    expect(humanRole(undefined)).toBe('');
  });
});
