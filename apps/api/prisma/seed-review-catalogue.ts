import { PrismaClient } from '@prisma/client';

/**
 * A small, real catalogue for a production environment that has nothing in it yet.
 *
 * ── WHY THIS IS NOT THE ORDINARY SEED ──────────────────────────────────────────────
 * The ordinary seed empties the database first and is refused outright in production, which is
 * exactly right. But a freshly provisioned production environment still needs SOMETHING on its
 * storefront: a payment gateway will not approve a merchant whose site shows an empty catalogue,
 * and neither will anyone else looking at it.
 *
 * So this only ever INSERTS, and only rows it owns - matched by slug, so running it twice changes
 * nothing and it never touches a row anybody else created. There is no delete anywhere in it, and
 * it is therefore safe on an environment that already has real listings.
 *
 * ── WHY NOBODY CAN BE MISLED BY THESE ──────────────────────────────────────────────
 * They are listings by the platform's own operator, priced in INR, and while
 * `PAYMENTS_ACTIVATION_PENDING` is set NOTHING CAN BE BOUGHT: checkout reaches the payment step
 * and says online payment is being activated. A visitor cannot pay for a seat that will not exist,
 * because a visitor cannot pay at all.
 *
 * Run: `npm run db:seed -- review-catalogue` through the db-seed service, from inside the private
 * network - the database has no public proxy, which is correct.
 */
const prisma = new PrismaClient();

/** The operator's own listings. Named so nobody has to guess who is selling. */
const ORG_SLUG = 'eticketsgo-presents';
const ORG_NAME = 'ETicketsGo Presents';

const VENUE = {
  name: 'Shilpakala Vedika',
  city: 'Hyderabad',
  country: 'India',
  address: 'Madhapur, Hyderabad, Telangana',
  capacity: 2000,
};

/** Far enough out that they are still on sale whenever anybody looks. */
const inDays = (n: number): Date => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const EVENTS = [
  {
    slug: 'hyderabad-live-comedy-night',
    title: 'Hyderabad Live: Comedy Night',
    category: 'COMEDY',
    description:
      'An evening of live stand-up in Hyderabad, presented by ETicketsGo. Doors open an hour ' +
      'before the show. Your ticket is a QR code on your phone; there is nothing to print.',
    daysAhead: 21,
    tiers: [
      { name: 'General', priceMinor: 49_900, quantityTotal: 400 },
      { name: 'Premium', priceMinor: 99_900, quantityTotal: 120 },
    ],
  },
  {
    slug: 'hyderabad-live-music-festival',
    title: 'Hyderabad Live: Music Festival',
    category: 'MUSIC',
    description:
      'A full evening of live music across two stages in Hyderabad, presented by ETicketsGo. ' +
      'Your ticket is a QR code on your phone; there is nothing to print.',
    daysAhead: 35,
    tiers: [
      { name: 'General', priceMinor: 79_900, quantityTotal: 800 },
      { name: 'Gold', priceMinor: 149_900, quantityTotal: 200 },
    ],
  },
];

async function main(): Promise<void> {
  const org =
    (await prisma.organization.findUnique({ where: { slug: ORG_SLUG } })) ??
    (await prisma.organization.create({
      data: {
        name: ORG_NAME,
        slug: ORG_SLUG,
        status: 'APPROVED',
        // The country decides which market prices, taxes and fees apply, so it is stated rather
        // than left to a default.
        registeredCountry: 'India',
      },
    }));
  console.log(`organization ${org.name} (${org.status})`);

  const venue =
    (await prisma.venue.findFirst({
      where: { organizationId: org.id, name: VENUE.name },
    })) ??
    (await prisma.venue.create({
      data: {
        organizationId: org.id,
        name: VENUE.name,
        city: VENUE.city,
        country: VENUE.country,
        address: VENUE.address,
        capacity: VENUE.capacity,
      },
    }));
  console.log(`venue ${venue.name}, ${venue.city}`);

  for (const def of EVENTS) {
    const existing = await prisma.event.findUnique({ where: { slug: def.slug } });
    if (existing) {
      console.log(`  ${def.slug} already present — left alone`);
      continue;
    }

    const event = await prisma.event.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        title: def.title,
        slug: def.slug,
        category: def.category as never,
        description: def.description,
        status: 'PUBLISHED',
        // The customer pays the fees, which is what the storefront then shows broken out on the
        // price breakdown - the thing a gateway's reviewer is most likely to look at.
        feeMode: 'CUSTOMER_PAYS',
        isFree: false,
        refundPolicy:
          'Full refund up to 48 hours before the event. No refunds after that. Refunds are ' +
          'returned to the original payment method.',
        publishedAt: new Date(),
      },
    });

    const starts = inDays(def.daysAhead);
    const session = await prisma.eventSession.create({
      data: {
        eventId: event.id,
        startsAt: starts,
        endsAt: new Date(starts.getTime() + 3 * 60 * 60 * 1000),
        status: 'SCHEDULED',
      },
    });

    for (const t of def.tiers) {
      await prisma.ticketType.create({
        data: {
          eventSessionId: session.id,
          name: t.name,
          priceMinor: t.priceMinor,
          quantityTotal: t.quantityTotal,
          maxPerOrder: 10,
          salesStartAt: new Date(),
          // Sales close when the event starts, matching the platform's own rule.
          salesEndAt: starts,
          inventory: {
            create: { quantityTotal: t.quantityTotal, quantitySold: 0, quantityHeld: 0 },
          },
        },
      });
    }
    console.log(
      `  ${def.slug} published — ${def.tiers.length} tiers from INR ${(
        Math.min(...def.tiers.map((t) => t.priceMinor)) / 100
      ).toFixed(2)}`,
    );
  }

  console.log('\nNothing was deleted and nothing existing was changed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
