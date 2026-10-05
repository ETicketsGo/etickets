/**
 * India GST rules — written INACTIVE, on purpose.
 *
 * ── WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF `seed.ts` ────────────────────────
 * Seeding runs on deploy. A tax rule that arrives active because somebody shipped a
 * container is a tax position taken by a build pipeline, and the first anybody would know
 * is a customer's receipt. So the rows land switched off and somebody has to turn them on:
 *
 *     npx tsx apps/api/prisma/seed-india-gst.ts            # write the rules, inactive
 *     npx tsx apps/api/prisma/seed-india-gst.ts --activate # switch them on, deliberately
 *
 * ── WHERE THE RATES COME FROM ──────────────────────────────────────────────────────
 * `docs/guides/INDIA-GST.md`, which cites its sources and states plainly that it is not tax
 * advice. Every rate here changed on 22 September 2025 under the GST Council's 56th meeting,
 * which is the point: rates move, so they live in rows a person can edit rather than in code
 * somebody has to redeploy.
 *
 * **Have your accountant read the table before activating it.** Nothing here has been
 * checked by anyone qualified to check it.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/*
  The table lives in its own module, and deliberately.

  This file is a PROGRAM: `main()` runs on import, which is what `prisma/seed-operation.ts`
  relies on when it does `require('./seed-india-gst')`. So anything that merely wants to READ
  the rates - a unit test, for instance - must be able to import them WITHOUT starting a
  database write. Keeping the data here made that impossible.
*/
import { GST_2_0, INDIA_GST_RULES, RUPEE, type IndiaGstRule } from './india-gst-rules';

/*
  Re-exported so existing importers keep working. New code should import from
  `./india-gst-rules` directly - that module cannot have a side effect, and this one can.
*/
export { INDIA_GST_RULES, type IndiaGstRule };

async function main() {
  const activate = process.argv.includes('--activate');

  for (const rule of INDIA_GST_RULES) {
    /*
      Matched on the shape rather than upserted on an id: these rows are configuration a
      human may have edited, and re-running this must not silently overwrite a rate somebody
      changed on advice. An existing rule with the same shape is left exactly as it is.
    */
    const existing = await prisma.taxRule.findFirst({
      where: {
        country: 'India',
        currency: 'INR',
        appliesTo: rule.appliesTo,
        taxGroup: rule.taxGroup,
        category: rule.category,
        minUnitMinor: rule.minUnitMinor ?? null,
        maxUnitMinor: rule.maxUnitMinor ?? null,
      },
    });

    if (existing) {
      if (activate && !existing.active) {
        await prisma.taxRule.update({ where: { id: existing.id }, data: { active: true } });
        console.log(`  ACTIVATED  ${describe(rule)}`);
      } else {
        console.log(`  exists     ${describe(rule)}${existing.active ? ' (active)' : ''}`);
      }
      continue;
    }

    await prisma.taxRule.create({
      data: {
        label: rule.label,
        rateBasisPoints: rule.rateBasisPoints,
        appliesTo: rule.appliesTo,
        taxGroup: rule.taxGroup,
        country: 'India',
        region: '*',
        currency: 'INR',
        category: rule.category,
        minUnitMinor: rule.minUnitMinor ?? null,
        maxUnitMinor: rule.maxUnitMinor ?? null,
        /*
          ── INCLUSIVE FOR THE TICKET, ADDED FOR THE FEE ────────────────────────────
          These are not the same question and this line used to answer both with `true`.

          A ticket price is quoted inclusive: the number on the poster is what you pay, so
          the GST is extracted from it. Adding on top would raise every advertised price by
          the rate the moment these rules were switched on.

          The platform's fee is the opposite. A ₹20 band is ₹20 of fee, and the GST on that
          supply is charged to the buyer — ₹23.60. Marked inclusive, the same ₹20 band would
          have collected ₹20 from the buyer and remitted ₹3.05 of it, leaving the platform
          ₹16.95 for a fee it had set at ₹20. Silently, and on every order.
        */
        inclusive: rule.appliesTo === 'TICKETS',
        // One levy, two lines intra-state (CGST + SGST) and one across a border (IGST).
        split: 'CGST_SGST',
        priority: rule.priority,
        effectiveFrom: GST_2_0,
        active: activate,
      },
    });
    console.log(`  created    ${describe(rule)}${activate ? ' (ACTIVE)' : ''}`);
  }

  const active = await prisma.taxRule.count({ where: { country: 'India', active: true } });
  console.log(
    active === 0
      ? '\nNo Indian rule is active. Nothing is being taxed. Re-run with --activate when your\n' +
          'accountant has confirmed the table in docs/guides/INDIA-GST.md.'
      : `\n${active} Indian GST rule(s) ACTIVE. Every INR booking is now taxed.`,
  );
}

function describe(rule: IndiaGstRule): string {
  const band =
    rule.minUnitMinor != null
      ? `above ₹${(rule.minUnitMinor - 1) / RUPEE}`
      : rule.maxUnitMinor != null
        ? `up to ₹${rule.maxUnitMinor / RUPEE}`
        : 'any price';
  return `${(rule.rateBasisPoints / 100).toFixed(0).padStart(2)}%  ${rule.category.padEnd(8)} ${rule.appliesTo.padEnd(8)} ${band}`;
}

/*
  Runs on import, and that is load-bearing.

  `prisma/seed-operation.ts` executes this seed with `require('./seed-india-gst')` and depends
  on this side effect. A `require.main === module` guard here would make the `india-gst` and
  `india-gst-activate` operations do NOTHING while still reporting success - a silent failure
  of exactly the shape that left production without a backup for five days.

  The rate table lives in `./india-gst-rules` so that reading it needs none of this.
*/
main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
