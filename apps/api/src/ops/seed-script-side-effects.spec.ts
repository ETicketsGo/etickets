import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * unit - reading the GST rate table must not run the seed, and the seed must still run itself.
 *
 * ── THE NEAR-MISS THIS COMES FROM ──────────────────────────────────────────────────
 * `INDIA_GST_RULES` was exported from `seed-india-gst.ts` so the shipped rates could be tested.
 * That file is a program whose `main()` runs on import, so the test opened a Prisma client and
 * wrote TaxRule rows into whatever DATABASE_URL was set.
 *
 * The first fix was `if (require.main === module)` around `main()`. It was nearly merged, and
 * it would have been worse than the bug: `seed-operation.ts` runs this seed with
 * `require('./seed-india-gst')` and depends on that exact side effect, so the guard would have
 * made `india-gst` and `india-gst-activate` do NOTHING while reporting success - the same
 * silent-success shape that left production five days without a backup.
 *
 * The data moved to its own module instead. These tests hold both halves of that, because
 * either one failing is a silent failure rather than a loud one.
 */

const prismaDir = join(__dirname, '../../prisma');
const read = (f: string) => readFileSync(join(prismaDir, f), 'utf8');

describe('the rate table is data, and data runs nothing', () => {
  const rules = read('india-gst-rules.ts');

  it('constructs no Prisma client', () => {
    // The whole point: importing the rates must not be able to touch a database.
    expect(rules).not.toContain('new PrismaClient');
    expect(rules).not.toContain('@prisma/client');
  });

  it('calls nothing at the top level', () => {
    expect(rules).not.toMatch(/^main\(\)/m);
    expect(rules).not.toContain('process.exit');
  });

  it('can be imported with no side effect at all', () => {
    /*
      Imported for real, not pattern-matched. If this module ever grows a side effect, the
      import itself is what would reveal it.
    */
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod =
      require('../../prisma/india-gst-rules') as typeof import('../../prisma/india-gst-rules');
    expect(mod.INDIA_GST_RULES.length).toBeGreaterThan(0);
  });
});

describe('the seed script still runs when required', () => {
  const seed = read('seed-india-gst.ts');
  const dispatcher = read('seed-operation.ts');

  it('invokes main() unconditionally, because its caller depends on that', () => {
    /*
      If somebody re-adds a `require.main === module` guard here, the india-gst operations
      silently stop writing anything. This is the assertion that stops that happening twice.
    */
    expect(seed).toMatch(/^main\(\)/m);
    /*
      Matched as CODE, not as prose. The file explains in a comment why that guard must not be
      added, and a naive `not.toContain` fails on the explanation - which is how a test starts
      arguing with its own documentation.
    */
    expect(seed).not.toMatch(/^\s*if \(require\.main === module\)/m);
  });

  it('is still the thing the dispatcher requires', () => {
    // The dependency this protects is real; assert it exists rather than assuming it.
    expect(dispatcher).toContain("require('./seed-india-gst')");
  });

  it('reads its rates from the data module rather than holding them', () => {
    expect(seed).toContain("from './india-gst-rules'");
    expect(seed).not.toMatch(/export const INDIA_GST_RULES\s*:/);
  });
});
