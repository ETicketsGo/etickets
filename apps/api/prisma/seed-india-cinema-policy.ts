/**
 * Andhra Pradesh and Telangana cinema pricing policies.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHAT IT REFUSES TO ─────────────────────────────────
 * It records the SHAPE both states regulate in — a per-ticket maintenance charge that
 * differs by whether the hall is cooled, and an online booking fee whose current position
 * this repository has not verified — and it records exactly one class of number: the
 * maintenance amounts of ₹5 and ₹3, which were supplied as the working figures.
 *
 * It records NO ticket-price ceiling for either state, and NO online-fee cap, because
 * nobody has produced the current government orders. Those columns are left null, which the
 * engine reads as "this policy states no limit" — NOT as "no limit exists". The difference
 * is the entire reason they are nullable rather than defaulted to a number somebody would
 * later mistake for law.
 *
 * ── WHY BOTH STATES SHIP `REQUIRES_APPROVAL` ───────────────────────────────────────
 * Because the platform's own ₹5/₹10/₹15/₹20 fee schedule is not evidence that charging it
 * in either state is lawful, and helping itself to a fee on that basis is the single most
 * likely way this system produces a real compliance failure. Under REQUIRES_APPROVAL the
 * ticket still sells and the fee is zero. Losing that revenue until somebody reads the
 * order is the correct thing to be losing.
 *
 *   npx tsx apps/api/prisma/seed-india-cinema-policy.ts             # write, DRAFT
 *   npx tsx apps/api/prisma/seed-india-cinema-policy.ts --activate  # write and ACTIVATE
 *
 * DRAFT by default and for the same reason the tax rules are: a policy that arrives ACTIVE
 * because somebody ran a deploy starts pricing real orders nobody decided to price.
 *
 * ── ACTIVATING THESE MAKES INDIA A REGULATED MARKET ────────────────────────────────
 * Read this before using `--activate`. Once ANY policy here is ACTIVE, every cinema in
 * India must resolve one — so a cinema in a state with no policy, or one that has not been
 * classified AC / air-cooled / non-AC, will FAIL CLOSED rather than sell at an unregulated
 * fee. That is the intended safety behaviour and it is not subtle. Classify the cinemas
 * first.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * The date these were entered, NOT a date either government chose.
 *
 * A real `effectiveFrom` is the date on the order. Nobody has produced one, so this says
 * only "from when this platform started applying it" — which is honest, and is why it is
 * named for what it is.
 */
const RECORDED_FROM = new Date('2026-09-04T00:00:00Z');

/** ₹5 and ₹3, in paise. The two amounts supplied as current working figures. */
const COOLED_MAINTENANCE_MINOR = 500;
const NON_AC_MAINTENANCE_MINOR = 300;

interface PolicySeed {
  region: string;
  climateType: 'AC' | 'AIR_COOLED' | 'NON_AC';
  maintenanceChargeMinor: number;
  maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE' | 'ADDED_TO_TICKET_PRICE';
  regulatoryReference: string;
  notes: string;
}

const SEEDS: PolicySeed[] = [
  // ── Andhra Pradesh ──────────────────────────────────────────────────────────────
  // Treatment INCLUDED: the working position supplied is that the charge sits inside the
  // published ticket price, so the customer's total does not move and the charge is a
  // disclosure. If the order says otherwise this is one field to change.
  {
    region: 'Andhra Pradesh',
    climateType: 'AC',
    maintenanceChargeMinor: COOLED_MAINTENANCE_MINOR,
    maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE',
    regulatoryReference: 'AP cinema maintenance charge — order reference NOT YET RECORDED',
    notes:
      'Amount supplied as the current working figure; the government order itself has not been obtained. No ticket-price ceiling recorded — absence here means unrecorded, not unlimited. Online fee REQUIRES_APPROVAL pending the current fee schedule.',
  },
  {
    region: 'Andhra Pradesh',
    climateType: 'AIR_COOLED',
    maintenanceChargeMinor: COOLED_MAINTENANCE_MINOR,
    maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE',
    regulatoryReference: 'AP cinema maintenance charge — order reference NOT YET RECORDED',
    notes: 'Air-cooled treated as the cooled band, per the supplied working figures.',
  },
  {
    region: 'Andhra Pradesh',
    climateType: 'NON_AC',
    maintenanceChargeMinor: NON_AC_MAINTENANCE_MINOR,
    maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE',
    regulatoryReference: 'AP cinema maintenance charge — order reference NOT YET RECORDED',
    notes: 'Amount supplied as the current working figure.',
  },

  // ── Telangana ───────────────────────────────────────────────────────────────────
  // Treatment ADDED rather than INCLUDED, and this is a REAL uncertainty rather than a
  // copy of AP: no position on Telangana's treatment was supplied. ADDED is the visible
  // reading — the customer sees the charge as its own line — which is the safer default to
  // be wrong about, because an included charge that should have been added under-collects
  // silently while an added one that should have been included is visible on every receipt
  // and will be reported within a day.
  {
    region: 'Telangana',
    climateType: 'AC',
    maintenanceChargeMinor: COOLED_MAINTENANCE_MINOR,
    maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
    regulatoryReference: 'TG cinema maintenance charge — order reference NOT YET RECORDED',
    notes:
      'Amount supplied as the current working figure. TREATMENT UNVERIFIED: recorded as ADDED because no position was supplied; confirm against the order before launch.',
  },
  {
    region: 'Telangana',
    climateType: 'AIR_COOLED',
    maintenanceChargeMinor: COOLED_MAINTENANCE_MINOR,
    maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
    regulatoryReference: 'TG cinema maintenance charge — order reference NOT YET RECORDED',
    notes: 'TREATMENT UNVERIFIED — see the AC row.',
  },
  {
    region: 'Telangana',
    climateType: 'NON_AC',
    maintenanceChargeMinor: NON_AC_MAINTENANCE_MINOR,
    maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
    regulatoryReference: 'TG cinema maintenance charge — order reference NOT YET RECORDED',
    notes: 'TREATMENT UNVERIFIED — see the AC row.',
  },
];

async function main(): Promise<void> {
  const activate = process.argv.includes('--activate');

  for (const seed of SEEDS) {
    /*
      Matched on the SHAPE rather than upserted on an id. These rows are configuration a
      human may have corrected on advice, and re-running this must never silently overwrite
      an amount somebody changed — nor create a second row for the same scope, which the
      resolver would refuse as ambiguous.
    */
    const existing = await prisma.cinemaPricingPolicy.findFirst({
      where: {
        country: 'India',
        region: seed.region,
        climateType: seed.climateType,
        district: '*',
        city: '*',
        seatCategory: null,
      },
    });

    if (existing) {
      if (activate && existing.status === 'DRAFT') {
        await prisma.cinemaPricingPolicy.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE' },
        });
        console.log(`  activated  ${seed.region} / ${seed.climateType}`);
      } else {
        console.log(`  unchanged  ${seed.region} / ${seed.climateType} (${existing.status})`);
      }
      continue;
    }

    await prisma.cinemaPricingPolicy.create({
      data: {
        country: 'India',
        region: seed.region,
        // Every other scope left wide: no district, local-body or seat-class distinction has
        // been supplied for either state. A narrower row can be added later and will win on
        // specificity without this one needing to change.
        district: '*',
        city: '*',
        currency: 'INR',
        climateType: seed.climateType,
        maintenanceChargeMinor: seed.maintenanceChargeMinor,
        maintenanceTreatment: seed.maintenanceTreatment,
        // No tax category: whether a maintenance charge is taxed, and at what rate, is a
        // TaxRule somebody writes on advice. Naming one here would assert a tax position.
        maintenanceTaxCategory: null,
        onlineFeePolicy: 'REQUIRES_APPROVAL',
        onlineFeeCapMinor: null,
        // NOT invented. Null reads as "this policy states no limit", never as "no limit".
        ticketPriceMinMinor: null,
        ticketPriceMaxMinor: null,
        ticketPriceRule: null,
        status: activate ? 'ACTIVE' : 'DRAFT',
        effectiveFrom: RECORDED_FROM,
        regulatoryReference: seed.regulatoryReference,
        notes: seed.notes,
      },
    });
    console.log(
      `  created    ${seed.region} / ${seed.climateType} — ${seed.maintenanceChargeMinor / 100} ${seed.maintenanceTreatment}${activate ? ' (ACTIVE)' : ''}`,
    );
  }

  const active = await prisma.cinemaPricingPolicy.count({ where: { status: 'ACTIVE' } });
  console.log(`\n  ${active} active cinema pricing policies.`);
  if (active > 0) {
    console.log(
      '  India is now a REGULATED market: any cinema that resolves no policy — including one\n' +
        '  that has not been classified AC / air-cooled / non-AC — will refuse online sales.',
    );
  } else {
    console.log('  All DRAFT. Nothing prices any order until one is activated.');
  }
  console.log(
    '\n  STILL UNRECORDED, and deliberately: AP and TG ticket-price ceilings, the online\n' +
      '  booking fee position and cap for both states, and whether a maintenance charge is\n' +
      '  taxable. None of these were invented.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
