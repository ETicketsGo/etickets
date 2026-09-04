/**
 * Andhra Pradesh and Telangana cinema pricing configuration.
 *
 * ── PROVENANCE, WHICH IS THE POINT OF THIS FILE ────────────────────────────────────
 * Andhra Pradesh's rate table below was transcribed from the product brief that cited
 * G.O.Ms.No.13, Home (General-A) Department, dated 07-03-2022. **The order itself is not in
 * this repository and has not been read by whoever wrote this file.** That is recorded on
 * the document row as `textReviewed: false`, and it is the difference between "these numbers
 * came from the order" and "these numbers came from somebody's summary of the order".
 *
 * Telangana has NO rate values here at all. G.O.77 dated 14-08-2026 is understood to have
 * revised the framework and is under active challenge; nothing about it is in this
 * repository. Populating it from news reports would put invented law into a pricing table,
 * so its policy exists as metadata with no monetary values.
 *
 *   npx tsx apps/api/prisma/seed-india-cinema-policy.ts             # write, DRAFT
 *   npx tsx apps/api/prisma/seed-india-cinema-policy.ts --activate  # write and ACTIVATE
 *
 * `--activate` touches ANDHRA PRADESH ONLY. Telangana cannot be activated by any flag:
 * its treatment is UNCONFIRMED and the database refuses such a row the ACTIVE status.
 *
 * ── ACTIVATING MAKES INDIA A REGULATED MARKET ──────────────────────────────────────
 * Once any policy here is ACTIVE, every cinema in India must resolve one. A cinema in an
 * unconfigured state, or one not classified by local body / format / climate, will FAIL
 * CLOSED rather than sell at an unregulated fee. Classify the cinemas first.
 */
import {
  PrismaClient,
  type LocalBodyType,
  type CinemaFormat,
  type ClimateType,
} from '@prisma/client';

const prisma = new PrismaClient();

const AP_REFERENCE = 'G.O.Ms.No.13, Home (General-A) Department, dated 07-03-2022';
const TG_HISTORICAL = 'G.O.Ms.No.120, Home (General) Department, dated 21-12-2021';
const TG_CURRENT = 'G.O.77 dated 14-08-2026';

/**
 * When this configuration began to apply on THIS platform.
 *
 * Not the date on any order — nobody has read one. Naming it for what it is stops it being
 * mistaken later for a commencement date.
 */
const RECORDED_FROM = new Date('2026-09-04T00:00:00Z');

/** ₹5 cooled, ₹3 not, per ticket. The two amounts the brief attributes to G.O.Ms.No.13. */
const COOLED = 500;
const NON_AC = 300;

/**
 * ── THE ANDHRA PRADESH RATE TABLE ─────────────────────────────────────────────────
 * Rupees as given in the brief; converted to paise on the way in, so the transcription can
 * be read against the source without doing arithmetic in your head.
 *
 * Every row is a COMPLETE statement for its classification — ceiling AND maintenance AND
 * fee posture — because whichever row wins on specificity is the only one consulted. A row
 * carrying a ceiling but no maintenance would silently drop the charge for exactly the
 * classifications that are most precisely described.
 */
interface Rate {
  localBody: LocalBodyType;
  format: CinemaFormat;
  /** Null where the order bands by format alone rather than by climate. */
  climate: ClimateType | null;
  seatCategory: string;
  rupees: number;
}

const AP_RATES: Rate[] = [
  // ── Municipal Corporation ───────────────────────────────────────────────────────
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'SINGLE_SCREEN',
    climate: 'NON_AC',
    seatCategory: 'NON_PREMIUM',
    rupees: 40,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'SINGLE_SCREEN',
    climate: 'NON_AC',
    seatCategory: 'PREMIUM',
    rupees: 60,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'SINGLE_SCREEN',
    climate: 'AC',
    seatCategory: 'NON_PREMIUM',
    rupees: 70,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'SINGLE_SCREEN',
    climate: 'AC',
    seatCategory: 'PREMIUM',
    rupees: 100,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'SINGLE_SCREEN',
    climate: 'AIR_COOLED',
    seatCategory: 'NON_PREMIUM',
    rupees: 70,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'SINGLE_SCREEN',
    climate: 'AIR_COOLED',
    seatCategory: 'PREMIUM',
    rupees: 100,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'SPECIAL_THEATRE',
    climate: null,
    seatCategory: 'NON_PREMIUM',
    rupees: 100,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'SPECIAL_THEATRE',
    climate: null,
    seatCategory: 'PREMIUM',
    rupees: 125,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'MULTIPLEX',
    climate: null,
    seatCategory: 'REGULAR',
    rupees: 150,
  },
  {
    localBody: 'MUNICIPAL_CORPORATION',
    format: 'MULTIPLEX',
    climate: null,
    seatCategory: 'RECLINER',
    rupees: 250,
  },

  // ── Municipality ────────────────────────────────────────────────────────────────
  {
    localBody: 'MUNICIPALITY',
    format: 'SINGLE_SCREEN',
    climate: 'NON_AC',
    seatCategory: 'NON_PREMIUM',
    rupees: 30,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'SINGLE_SCREEN',
    climate: 'NON_AC',
    seatCategory: 'PREMIUM',
    rupees: 50,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'SINGLE_SCREEN',
    climate: 'AC',
    seatCategory: 'NON_PREMIUM',
    rupees: 60,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'SINGLE_SCREEN',
    climate: 'AC',
    seatCategory: 'PREMIUM',
    rupees: 80,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'SINGLE_SCREEN',
    climate: 'AIR_COOLED',
    seatCategory: 'NON_PREMIUM',
    rupees: 60,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'SINGLE_SCREEN',
    climate: 'AIR_COOLED',
    seatCategory: 'PREMIUM',
    rupees: 80,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'SPECIAL_THEATRE',
    climate: null,
    seatCategory: 'NON_PREMIUM',
    rupees: 80,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'SPECIAL_THEATRE',
    climate: null,
    seatCategory: 'PREMIUM',
    rupees: 100,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'MULTIPLEX',
    climate: null,
    seatCategory: 'REGULAR',
    rupees: 125,
  },
  {
    localBody: 'MUNICIPALITY',
    format: 'MULTIPLEX',
    climate: null,
    seatCategory: 'RECLINER',
    rupees: 250,
  },

  // ── Nagar Panchayat / Gram Panchayat ────────────────────────────────────────────
  // Two local-body types, one rate column in the order, so each rate is written twice
  // rather than one being made to stand in for the other.
  ...(['NAGAR_PANCHAYAT', 'GRAM_PANCHAYAT'] as LocalBodyType[]).flatMap((lb): Rate[] => [
    {
      localBody: lb,
      format: 'SINGLE_SCREEN',
      climate: 'NON_AC',
      seatCategory: 'NON_PREMIUM',
      rupees: 20,
    },
    {
      localBody: lb,
      format: 'SINGLE_SCREEN',
      climate: 'NON_AC',
      seatCategory: 'PREMIUM',
      rupees: 40,
    },
    {
      localBody: lb,
      format: 'SINGLE_SCREEN',
      climate: 'AC',
      seatCategory: 'NON_PREMIUM',
      rupees: 50,
    },
    { localBody: lb, format: 'SINGLE_SCREEN', climate: 'AC', seatCategory: 'PREMIUM', rupees: 70 },
    {
      localBody: lb,
      format: 'SINGLE_SCREEN',
      climate: 'AIR_COOLED',
      seatCategory: 'NON_PREMIUM',
      rupees: 50,
    },
    {
      localBody: lb,
      format: 'SINGLE_SCREEN',
      climate: 'AIR_COOLED',
      seatCategory: 'PREMIUM',
      rupees: 70,
    },
    {
      localBody: lb,
      format: 'SPECIAL_THEATRE',
      climate: null,
      seatCategory: 'NON_PREMIUM',
      rupees: 70,
    },
    {
      localBody: lb,
      format: 'SPECIAL_THEATRE',
      climate: null,
      seatCategory: 'PREMIUM',
      rupees: 90,
    },
    { localBody: lb, format: 'MULTIPLEX', climate: null, seatCategory: 'REGULAR', rupees: 100 },
    // NO recliner row: the brief gives a Nagar/Gram Panchayat multiplex regular rate and no
    // recliner rate. An absent rate is left absent — the organizer panel then says the
    // ceiling is unrecorded for that classification, which is true, rather than inheriting
    // a number from a different local body, which would not be.
  ]),
];

/** The maintenance charge for a classification, by climate. */
const maintenanceFor = (climate: ClimateType | null): number =>
  climate === 'NON_AC' ? NON_AC : COOLED;

async function upsertDocument(reference: string, region: string, notes: string): Promise<string> {
  const existing = await prisma.regulatoryDocument.findUnique({ where: { reference } });
  if (existing) return existing.id;
  const row = await prisma.regulatoryDocument.create({
    data: {
      reference,
      country: 'India',
      region,
      // No URL invented. A news report about an order is not the order.
      documentUrl: null,
      textReviewed: false,
      notes,
    },
  });
  return row.id;
}

async function main(): Promise<void> {
  const activate = process.argv.includes('--activate');

  // ── Documents ─────────────────────────────────────────────────────────────────────
  const apDoc = await upsertDocument(
    AP_REFERENCE,
    'Andhra Pradesh',
    'Rate table transcribed from the product brief, NOT from the order text. Order states rates are exclusive of GST, inclusive of maintenance charges, and inclusive of service charges for online booking.',
  );
  const tgHistoricalDoc = await upsertDocument(
    TG_HISTORICAL,
    'Telangana',
    'Historical. Retained as regulatory evidence; understood to be superseded or modified by G.O.77 dated 14-08-2026. Not used to price anything.',
  );
  const tgCurrentDoc = await upsertDocument(
    TG_CURRENT,
    'Telangana',
    'The current framework, and NOT IN THIS REPOSITORY. Reported to be under challenge by exhibitor associations. No rate, treatment or fee value has been taken from secondary reporting.',
  );
  console.log(
    `  documents  ${AP_REFERENCE.slice(0, 24)}…, ${TG_HISTORICAL.slice(0, 24)}…, ${TG_CURRENT}`,
  );

  // ── Andhra Pradesh: one complete row per classification ──────────────────────────
  let created = 0;
  let activated = 0;
  for (const rate of AP_RATES) {
    const where = {
      country: 'India',
      region: 'Andhra Pradesh',
      district: '*',
      city: '*',
      localBodyType: rate.localBody,
      cinemaFormat: rate.format,
      climateType: rate.climate,
      seatCategory: rate.seatCategory,
    };
    const existing = await prisma.cinemaPricingPolicy.findFirst({ where });
    if (existing) {
      if (activate && existing.status === 'DRAFT') {
        await prisma.cinemaPricingPolicy.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE' },
        });
        activated += 1;
      }
      continue;
    }
    await prisma.cinemaPricingPolicy.create({
      data: {
        ...where,
        currency: 'INR',
        maintenanceChargeMinor: maintenanceFor(rate.climate),
        // The order states the rate is INCLUSIVE of maintenance: the published price already
        // contains it, so the customer's total does not move and the charge is disclosed.
        maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE',
        // No tax category. Whether a maintenance charge is taxed is a TaxRule somebody writes
        // on advice; naming one here would assert a tax position nobody has taken.
        maintenanceTaxCategory: null,
        /*
          The order states the rate is inclusive of service charges for online booking. What
          ETicketsGo — a third party rather than the exhibitor — may separately charge is a
          different question and an unanswered one, so no fee is charged and none is assumed
          lawful. `null` cap here is NOT "unrestricted": the ceiling for REQUIRES_APPROVAL is
          computed as zero.
        */
        onlineFeePolicy: 'REQUIRES_APPROVAL',
        onlineFeeCapMinor: null,
        ticketPriceMinMinor: null,
        ticketPriceMaxMinor: rate.rupees * 100,
        ticketPriceRule: `${AP_REFERENCE}: ${rate.localBody.replace(/_/g, ' ').toLowerCase()}, ${rate.format.replace(/_/g, ' ').toLowerCase()}${rate.climate ? `, ${rate.climate.replace(/_/g, '-').toLowerCase()}` : ''}, ${rate.seatCategory.replace(/_/g, '-').toLowerCase()} — Rs ${rate.rupees} exclusive of GST, inclusive of maintenance.`,
        status: activate ? 'ACTIVE' : 'DRAFT',
        effectiveFrom: RECORDED_FROM,
        regulatoryDocumentId: apDoc,
        regulatoryReference: AP_REFERENCE,
        notes:
          'Ceiling transcribed from the product brief, not from the order text. Maintenance amount and INCLUDED treatment per the same brief.',
      },
    });
    created += 1;
  }
  console.log(
    `  AP         ${created} rate rows created${activated ? `, ${activated} activated` : ''}`,
  );

  /*
    ── A CLIMATE-ONLY FALLBACK, SO A BOOKING ALWAYS RESOLVES ────────────────────────
    The rows above all name a seat class. A cart whose seat class the platform cannot
    identify would match none of them, and in a regulated market that means FAIL CLOSED —
    the customer cannot buy a ticket because their seat category is called something the
    rate table does not recognise.

    These broader rows carry the same maintenance and the same fee posture but NO ceiling, so
    such an order still prices correctly and the organizer panel reports that no ceiling could
    be matched. Less specific, so they never displace a rate row where one applies.
  */
  let fallbacks = 0;
  for (const climate of ['AC', 'AIR_COOLED', 'NON_AC'] as ClimateType[]) {
    const where = {
      country: 'India',
      region: 'Andhra Pradesh',
      district: '*',
      city: '*',
      localBodyType: null,
      cinemaFormat: null,
      climateType: climate,
      seatCategory: null,
    };
    if (await prisma.cinemaPricingPolicy.findFirst({ where })) continue;
    await prisma.cinemaPricingPolicy.create({
      data: {
        ...where,
        currency: 'INR',
        maintenanceChargeMinor: maintenanceFor(climate),
        maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE',
        onlineFeePolicy: 'REQUIRES_APPROVAL',
        ticketPriceMaxMinor: null,
        ticketPriceRule:
          'Maintenance only. No ceiling: this row applies when the seat class does not match a rate row, and inheriting a ceiling from a different class would be an invention.',
        status: activate ? 'ACTIVE' : 'DRAFT',
        effectiveFrom: RECORDED_FROM,
        regulatoryDocumentId: apDoc,
        regulatoryReference: AP_REFERENCE,
        notes: 'Fallback so an unrecognised seat class still resolves maintenance correctly.',
      },
    });
    fallbacks += 1;
  }
  console.log(`  AP         ${fallbacks} maintenance fallback rows`);

  // ── Telangana: metadata only ─────────────────────────────────────────────────────
  for (const [reference, docId, note] of [
    [
      TG_HISTORICAL,
      tgHistoricalDoc,
      'Historical evidence only. Superseded or modified by G.O.77; never activate.',
    ],
    [
      TG_CURRENT,
      tgCurrentDoc,
      'Awaiting the authoritative order. Maintenance treatment UNCONFIRMED — the database refuses to activate this row, by design.',
    ],
  ] as [string, string, string][]) {
    const where = {
      country: 'India',
      region: 'Telangana',
      district: '*',
      city: '*',
      localBodyType: null,
      cinemaFormat: null,
      climateType: null,
      seatCategory: null,
      regulatoryReference: reference,
    };
    if (await prisma.cinemaPricingPolicy.findFirst({ where })) continue;
    await prisma.cinemaPricingPolicy.create({
      data: {
        ...where,
        currency: 'INR',
        /*
          NO amount, and no treatment.

          This row used to carry `COOLED` — the ₹5 that the brief attributes to ANDHRA
          PRADESH's G.O.Ms.No.13. Sharing that constant put an Andhra Pradesh number on a
          Telangana order, on the row for an order (G.O.77) whose text is not in this
          repository at all. Two different governments' figures behind one identifier, where a
          later change to the AP rate would silently have moved Telangana's too.
          That is the same class of mistake as the ADDED treatment this file already removed:
          a value nobody sourced, sitting where a sourced value belongs.

          Zero is not a claim that Telangana charges nothing. It is the absence of a figure,
          which is what UNCONFIRMED alongside it says — and the row cannot be activated in
          that state, so nothing can price against the gap.
        */
        maintenanceChargeMinor: 0,
        maintenanceTreatment: 'UNCONFIRMED',
        onlineFeePolicy: 'REQUIRES_APPROVAL',
        onlineFeeCapMinor: null,
        ticketPriceMaxMinor: null,
        ticketPriceRule: null,
        // DRAFT regardless of --activate. The constraint would refuse ACTIVE anyway; saying
        // so here means the flag never even attempts it.
        status: 'DRAFT',
        effectiveFrom: RECORDED_FROM,
        regulatoryDocumentId: docId,
        notes: note,
      },
    });
  }
  console.log('  TG         2 metadata rows (historical + G.O.77), both DRAFT, no rate values');

  // ── Summary ──────────────────────────────────────────────────────────────────────
  const active = await prisma.cinemaPricingPolicy.count({ where: { status: 'ACTIVE' } });
  console.log(`\n  ${active} active cinema pricing policies.`);
  console.log(
    active > 0
      ? '  India is REGULATED: an unclassified cinema will refuse online sales.'
      : '  All DRAFT. Nothing prices any order until one is activated.',
  );
  console.log(
    '\n  NOT RECORDED, deliberately:\n' +
      '    - the AP order text itself (rates transcribed from a brief; textReviewed = false)\n' +
      '    - what ETicketsGo may charge as a third party in AP (REQUIRES_APPROVAL, no cap)\n' +
      '    - every Telangana rate, ceiling and treatment (G.O.77 not in this repository)\n' +
      '    - whether a maintenance charge is taxable\n' +
      '    - Nagar/Gram Panchayat multiplex recliner rate (not given in the brief)',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
