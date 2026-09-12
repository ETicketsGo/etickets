import { readFileSync } from 'fs';
import { join } from 'path';
import { countryAliases, currencyForCountry } from '../common/country';

/**
 * The coupon-currency backfill and the API must name the same currency for the same venue.
 *
 * The migration gives each existing FIXED coupon its organization's selling currency with a SQL
 * CASE over the venue's country, and the API gives a new coupon the same thing through
 * `currencyForCountry`. Two copies of a country table is how they come to disagree — a venue
 * stored as "United States of America" backfilled to INR while new codes for it were USD — so
 * this reads the CASE out of the migration and holds it to the shared table.
 */
const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20260915100000_coupon_currency/migration.sql'),
  'utf8',
);

const branches = [
  ...sql.matchAll(/WHEN LOWER\(TRIM\(v\."country"\)\) IN \(([^)]*)\) THEN '([A-Z]{3})'/g),
].map((m) => ({
  spellings: [...m[1].matchAll(/'([^']*)'/g)].map((s) => s[1]),
  currency: m[2],
}));

describe('the coupon currency backfill', () => {
  it('maps every spelling it knows to the currency the API would choose', () => {
    expect(branches.length).toBeGreaterThan(0);
    for (const { spellings, currency } of branches) {
      for (const spelling of spellings) {
        expect([spelling, currencyForCountry(spelling)]).toEqual([spelling, currency]);
      }
    }
  });

  it('knows every spelling the API knows, for every country with a currency', () => {
    for (const code of ['IN', 'US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ']) {
      const branch = branches.find((b) => b.currency === currencyForCountry(code));
      expect(branch).toBeDefined();
      expect([...branch!.spellings].sort()).toEqual([...countryAliases(code)].sort());
    }
  });

  it('only fills FIXED coupons that have no currency yet, and falls back to INR', () => {
    expect(sql).toMatch(/WHERE c\."type" = 'FIXED'\s+AND c\."currency" IS NULL/);
    expect(sql).toMatch(/COALESCE\([\s\S]*'INR'\s*\)/);
  });
});
