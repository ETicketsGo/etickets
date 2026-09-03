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

/** 22 September 2025 — GST 2.0. Rules before this instant are a different table. */
const GST_2_0 = new Date('2025-09-22T00:00:00.000Z');

const RUPEE = 100;

interface Rule {
  label: string;
  /**
   * Rules in one group are ALTERNATIVES. Admission is one group so the catch-all does not
   * stack on top of a banded cinema rate — which it did, taxing every cinema ticket twice,
   * until a real order was priced against this table.
   */
  taxGroup: string;
  rateBasisPoints: number;
  appliesTo: 'TICKETS' | 'FEES';
  category: string;
  minUnitMinor?: number;
  maxUnitMinor?: number;
  priority: number;
  note: string;
}

/**
 * Bands are on the price of ONE ticket, which is how they are written in the law and why
 * the engine refuses to rate a banded rule off an order total.
 */
const INDIA: Rule[] = [
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 500,
    appliesTo: 'TICKETS',
    category: 'MOVIE',
    maxUnitMinor: 100 * RUPEE,
    priority: 10,
    note: 'Cinema admission at or below ₹100 — cut from 12% on 22 Sep 2025.',
  },
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    category: 'MOVIE',
    minUnitMinor: 100 * RUPEE + 1,
    priority: 11,
    note: 'Cinema admission above ₹100 — unchanged at 18%.',
  },
  {
    /*
      Zero is a RATE here, not an absence. A recognised sporting fixture at or below ₹500 is
      exempt, and an exempt sale still belongs on the invoice as a 0% line: "we charged you
      no tax" and "we never considered tax" look identical when the line is missing, and only
      one of them is auditable.
    */
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 0,
    appliesTo: 'TICKETS',
    category: 'Sports',
    maxUnitMinor: 500 * RUPEE,
    priority: 20,
    note: 'Recognised sporting event at or below ₹500 — exempt. Shown as a 0% line.',
  },
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    category: 'Sports',
    minUnitMinor: 500 * RUPEE + 1,
    priority: 21,
    note: 'Recognised sporting event above ₹500.',
  },
  {
    /*
      The catch-all for everything that is not a cinema seat or a recognised fixture:
      concerts, comedy, theatre, conferences. It carries no band because the rate does not
      band — only cinema and sport do.

      Deliberately NOT covering IPL, casinos, betting or racing, which moved to 40% on the
      same date. Those need a category somebody assigns on purpose; inheriting 18% by
      default would under-collect by more than half, and inheriting 40% by default would
      overcharge every concert. Neither guess is one this file gets to make.
    */
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    category: '*',
    priority: 30,
    note: 'Other entertainment / cultural / artistic admission. NOT IPL, casinos or betting (40%).',
  },
  {
    taxGroup: 'FEE',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'FEES',
    category: '*',
    priority: 40,
    note: 'The platform booking fee is the platform’s own supply of service, taxed in its own right.',
  },
];

async function main() {
  const activate = process.argv.includes('--activate');

  for (const rule of INDIA) {
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

function describe(rule: Rule): string {
  const band =
    rule.minUnitMinor != null
      ? `above ₹${(rule.minUnitMinor - 1) / RUPEE}`
      : rule.maxUnitMinor != null
        ? `up to ₹${rule.maxUnitMinor / RUPEE}`
        : 'any price';
  return `${(rule.rateBasisPoints / 100).toFixed(0).padStart(2)}%  ${rule.category.padEnd(8)} ${rule.appliesTo.padEnd(8)} ${band}`;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
