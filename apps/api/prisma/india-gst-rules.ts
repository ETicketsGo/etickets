/**
 * The Indian GST rate table. DATA ONLY - this module runs nothing.
 *
 * ── WHY IT IS NOT IN `seed-india-gst.ts` ───────────────────────────────────────────
 * It used to be, and exporting it so the shipped table could be tested created a trap: that
 * file is a PROGRAM whose `main()` runs on import, so a unit test that only wanted the rate
 * table opened a Prisma client and wrote TaxRule rows into whatever DATABASE_URL was set.
 *
 * The first fix attempted was `if (require.main === module)` around `main()`. That would have
 * been worse: `prisma/seed-operation.ts` runs this seed with `require('./seed-india-gst')` and
 * depends on exactly that import side effect, so the guard would have made the `india-gst` and
 * `india-gst-activate` operations do NOTHING while still reporting success - the same
 * silent-success shape that left production without a backup for five days.
 *
 * So the data moved out instead. Importing a table cannot have a side effect, because there is
 * nothing here to run. The script keeps its side effect, and its one caller keeps working.
 *
 * ── WHERE THE RATES COME FROM ──────────────────────────────────────────────────────
 * `docs/guides/INDIA-GST.md`, which cites its sources and says plainly that it is not tax
 * advice. Every rate changed on 22 September 2025 under the GST Council's 56th meeting.
 *
 * **Have your accountant read the table before activating it.** Nothing here has been checked
 * by anybody qualified to check it.
 */

/** 22 September 2025 — GST 2.0. Rules before this instant are a different table. */
export const GST_2_0 = new Date('2025-09-22T00:00:00.000Z');

export const RUPEE = 100;

export interface IndiaGstRule {
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
 * The shipped Indian rule set, exported so it can be TESTED rather than merely run.
 *
 * Bands are on the price of ONE ticket, which is how they are written in the law and why the
 * engine refuses to rate a banded rule off an order total.
 *
 * This table is what somebody types `--activate` against on a production database. Until it was
 * exported, nothing exercised it: the tax engine had thorough coverage against hand-built rules,
 * and the rules we actually ship had none. A wrong band or rate here would have reached a real
 * customer's receipt with every unit test still green. It is now priced against the worked
 * examples in the guide by `src/pricing/india-gst-activation.spec.ts`.
 */
export const INDIA_GST_RULES: IndiaGstRule[] = [
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
