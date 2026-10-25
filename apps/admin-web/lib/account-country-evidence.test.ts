import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Accounts page labels every kind of country evidence for what it is.
 *
 * Production showed 7 of 8 accounts as "Country not known" because only bookings and organizer
 * memberships counted. The API now also returns the person's chosen residence, the network's
 * country at sign-up and the verified phone's calling code. This pins that the page shows each
 * under its own label and never calls a calling code (+1 is the US AND Canada) a country.
 *
 * Read as source: the page is a client component over live queries; its rendering is checked in
 * a browser during QA certification (docs/auth/PHONE-IDENTITY.md, section 5.3).
 */
const page = readFileSync(resolve(__dirname, '../app/admin/users/page.tsx'), 'utf8');

describe('admin Accounts: country evidence', () => {
  it('labels each kind of evidence by its source', () => {
    expect(page).toContain('Lives in:');
    expect(page).toContain('Phone:');
    expect(page).toContain('Detected:');
    expect(page).toContain('Active in:');
    expect(page).toContain('No country evidence');
  });

  it('shows the calling code with the countries sharing it, never as a residence', () => {
    expect(page).toMatch(/u\.phoneCallingCodeLabel/);
    // The residence line reads only the chosen residence.
    expect(page).toMatch(/Lives in:<\/span>\s*<CountryLabel stored=\{u\.countryOfResidence\}/);
  });

  it('no longer calls "no activity" "country not known"', () => {
    expect(page).not.toMatch(/label="Country not known"/);
    expect(page).not.toMatch(/>Not known</);
    expect(page).toContain('No activity country yet');
    expect(page).toContain('No country evidence at all');
  });

  it('still works against an API older than the new fields', () => {
    expect(page).toMatch(/u\.activityCountries \?\? u\.countries/);
    expect(page).toMatch(/withoutActivityCountry \?\? summary\.data\.withoutCountry/);
  });
});
