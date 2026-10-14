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
 * `docs/finance/INDIA-GST-CLASSIFICATION.md` (per-category rates, SAC codes, CBIC sources) and
 * `docs/guides/INDIA-GST.md`, which cite their sources and say plainly that they are not tax
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
/*
  ── CATEGORIES ARE THE TAX CLASSIFICATION, NOT A GUESS ──────────────────────────────────
  Each `category` is one of TAX_CATEGORIES (@eticketsgo/shared-types), set by a person on the
  event (or one ticket type). It used to be 'MOVIE' and 'Sports' while the booking passed the
  seat class (REGULAR, RECLINER...) as the category, so neither ever matched and every ticket
  fell to a '*' catch-all at 18%. There is no catch-all any more: within the ADMISSION group a
  '*' rule cannot rate a ticket, and a category with no rule here - SPORTS_OTHER (IPL-style,
  40%) and CONFERENCE - is REFUSED at checkout until somebody qualified writes its rule.

  Rates, thresholds and sources: docs/finance/INDIA-GST-CLASSIFICATION.md, including the list of
  points that need professional tax review before any of this is activated.
*/
export const INDIA_GST_RULES: IndiaGstRule[] = [
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 500,
    appliesTo: 'TICKETS',
    category: 'CINEMA',
    maxUnitMinor: 100 * RUPEE,
    priority: 10,
    note: 'Cinema admission at or below Rs 100 - heading 9996 (ii), 12% to 5% from 22 Sep 2025.',
  },
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    category: 'CINEMA',
    minUnitMinor: 100 * RUPEE + 1,
    priority: 11,
    note: 'Cinema admission above Rs 100 - heading 9996 (iia), 18%.',
  },
  {
    /*
      Zero is a RATE here, not an absence. Admission to a recognised sporting event at or below
      Rs 500 is exempt, and an exempt sale still belongs on the invoice as a 0% line: "we
      charged you no tax" and "we never considered tax" look identical when the line is
      missing, and only one of them is auditable.
    */
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 0,
    appliesTo: 'TICKETS',
    category: 'SPORTS_RECOGNISED',
    maxUnitMinor: 500 * RUPEE,
    priority: 20,
    note: 'Recognised sporting event at or below Rs 500 - exempt (12/2017 entry 81). 0% line.',
  },
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    category: 'SPORTS_RECOGNISED',
    minUnitMinor: 500 * RUPEE + 1,
    priority: 21,
    note: 'Recognised sporting event above Rs 500 - excluded from 9996 (iiia), so 18%.',
  },
  {
    /*
      The same Rs 500 exemption covers circus, dance, theatre, drama, ballet, award functions,
      concerts, pageants and musical performances (12/2017 entry 81 as substituted by 3/2018).
      The old table taxed every concert at 18% whatever its price; that over-collected on every
      ticket of Rs 500 or less. Flagged for professional review all the same - see the doc.
    */
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 0,
    appliesTo: 'TICKETS',
    category: 'LIVE_PERFORMANCE',
    maxUnitMinor: 500 * RUPEE,
    priority: 30,
    note: 'Concert, theatre, dance, circus, award show at or below Rs 500 - exempt (entry 81).',
  },
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    category: 'LIVE_PERFORMANCE',
    minUnitMinor: 500 * RUPEE + 1,
    priority: 31,
    note: 'Live performance above Rs 500 - heading 9996 (i)/(iii)/(vi), 18%.',
  },
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    category: 'AMUSEMENT',
    priority: 40,
    note: 'Theme park, water park, rides, go-karting - heading 9996 (iii), 18%.',
  },
  {
    taxGroup: 'ADMISSION',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    category: 'OTHER_ENTERTAINMENT',
    priority: 50,
    note: 'Other recreational, cultural and sporting services - heading 9996 (vi), 18%.',
  },
  {
    taxGroup: 'FEE',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'FEES',
    category: '*',
    priority: 60,
    note: 'The platform booking fee is the platform’s own supply of service, taxed in its own right.',
  },
];
