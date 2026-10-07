import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '../../prisma/migrations/20261007090000_space_belongs_to_venue/migration.sql'),
  'utf8',
);
const audit = readFileSync(join(__dirname, '../../scripts/audit-space-location.mjs'), 'utf8');

describe('space-to-venue migration safety', () => {
  it('A/F: copies only a tenant-consistent Cinema venue and preserves an existing Screen venue', () => {
    const guardedJoins = migration.match(
      /JOIN "Venue" v ON v\."id" = c\."venueId" AND v\."organizationId" = c\."organizationId"/g,
    );
    expect(guardedJoins).toHaveLength(2);
    expect(migration).toMatch(/AND s\."venueId" IS NULL/g);
  });

  it('B: preserves an unknown Cinema country instead of manufacturing India', () => {
    const countryNullable = migration.indexOf(
      'ALTER TABLE "Venue" ALTER COLUMN "country" DROP NOT NULL',
    );
    const historicalInsert = migration.indexOf('INSERT INTO "Venue"');
    expect(countryNullable).toBeGreaterThan(0);
    expect(countryNullable).toBeLessThan(historicalInsert);
    expect(migration).toContain('c."country"');
    expect(migration).not.toMatch(/COALESCE\(c\."country"/i);
    expect(migration).not.toMatch(/c\."country"[^\n]*'India'/i);
  });

  it('C: copies the stored timezone without manufacturing Asia/Kolkata', () => {
    expect(migration).toContain('c."timezone"');
    expect(migration).not.toMatch(/COALESCE\(c\."timezone"/i);
    expect(migration).not.toContain("'Asia/Kolkata'");
  });

  it('D: aborts before schema changes when Cinema and Venue organizations differ', () => {
    const guard = migration.indexOf('Cinema/Venue organization mismatch');
    const firstAlter = migration.indexOf('ALTER TABLE "Screen"');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(firstAlter);
    expect(migration).toMatch(/c\."organizationId" <> v\."organizationId"/);
    expect(migration).toMatch(/RAISE EXCEPTION/);
  });

  it('E: creates one deterministic Venue for a Cinema without one, preserving nullable fields', () => {
    expect(migration).toContain(`SELECT 'vn_' || c."id"`);
    expect(migration).toMatch(/WHERE c\."venueId" IS NULL/);
    expect(migration).toContain('c."country"');
    expect(migration).toContain('c."region"');
    expect(migration).toContain('c."timezone"');
    expect(migration).toContain('c."address"');
  });

  it('G: delegates conflicting location values to the read-only audit instead of rewriting them', () => {
    expect(migration).not.toMatch(/SET "country"/);
    expect(migration).not.toMatch(/SET "region"/);
    expect(migration).not.toMatch(/SET "timezone"/);
    for (const field of ['city', 'country', 'region', 'timezone', 'address']) {
      expect(audit).toContain(`'${field}'`);
    }
  });
});

describe('space-location audit coverage', () => {
  it.each([
    'orphans',
    'cinemaVenueOrganizationMismatches',
    'screenOrganizationMismatches',
    'venuesWithUnknownLocation',
    'conflicts',
    'spacesWithNoVenue',
    'spacesDisagreeing',
  ])('reports %s and treats it as requiring intervention', (finding) => {
    expect(audit).toContain(finding);
    expect(audit).toMatch(new RegExp(`${finding}\\.length > 0`));
  });
});
