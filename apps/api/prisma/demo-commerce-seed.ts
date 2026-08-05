/**
 * Demo Experience-Commerce seed (v2.1 pilot tooling). Layers a realistic set of
 * add-ons and bundles onto an already-seeded PUBLISHED event so a pilot demo shows
 * the full commerce platform (merch / parking / F&B / donation + VIP & family
 * bundles). Operational demo data only — NOT a product feature, NOT for production.
 *
 * Run after the base seed:  npm run db:seed && npm run db:demo-commerce
 * Idempotent: re-running replaces this event's demo add-ons/bundles.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Pick a published, general-admission event that has ticket types (commerce is
  // for non-seat sessions; movies are excluded).
  const event = await prisma.event.findFirst({
    where: { status: 'PUBLISHED', experienceType: 'EVENT' },
    include: { sessions: { include: { ticketTypes: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const ticketTypes = event?.sessions.flatMap((s) => s.ticketTypes) ?? [];
  if (!event || ticketTypes.length === 0) {
    console.log('No seeded published event with ticket types found — run `npm run db:seed` first.');
    return;
  }

  // Idempotent reset: drop any prior demo commerce for this event.
  await prisma.bundle.deleteMany({ where: { eventId: event.id } });
  await prisma.addOn.deleteMany({ where: { eventId: event.id } });

  const vip = ticketTypes.find((t) => /vip/i.test(t.name)) ?? ticketTypes[ticketTypes.length - 1];
  const general = ticketTypes.find((t) => /general/i.test(t.name)) ?? ticketTypes[0];

  // ── Add-ons ──
  const addOnDefs = [
    {
      type: 'MERCHANDISE',
      name: 'Event T-Shirt',
      priceMinor: 49_900,
      quantityTotal: 200,
      maxPerOrder: 5,
    },
    {
      type: 'PARKING',
      name: 'Reserved Parking Pass',
      priceMinor: 15_000,
      quantityTotal: 100,
      maxPerOrder: 2,
    },
    {
      type: 'FOOD_BEVERAGE',
      name: 'Combo Meal Voucher',
      priceMinor: 29_900,
      quantityTotal: 300,
      maxPerOrder: 10,
    },
    {
      type: 'DONATION',
      name: 'Support the Artists',
      priceMinor: 10_000,
      quantityTotal: null,
      maxPerOrder: 20,
    },
  ] as const;

  const addOns: Record<string, string> = {};
  for (const a of addOnDefs) {
    const created = await prisma.addOn.create({
      data: {
        eventId: event.id,
        type: a.type,
        name: a.name,
        description: `${a.name} for ${event.title}.`,
        priceMinor: a.priceMinor,
        maxPerOrder: a.maxPerOrder,
        enabled: true,
        inventory: { create: { quantityTotal: a.quantityTotal } },
      },
    });
    addOns[a.name] = created.id;
  }

  // ── Bundles ──
  await prisma.bundle.create({
    data: {
      eventId: event.id,
      type: 'VIP',
      name: 'VIP Experience Bundle',
      description: 'A VIP ticket plus an event tee — 10% off the combined price.',
      pricingKind: 'PERCENT_DISCOUNT',
      discountPercent: 10,
      maxPerOrder: 4,
      enabled: true,
      items: {
        create: [
          { ticketTypeId: vip.id, quantity: 1 },
          { addOnId: addOns['Event T-Shirt'], quantity: 1 },
        ],
      },
    },
  });

  await prisma.bundle.create({
    data: {
      eventId: event.id,
      type: 'FAMILY',
      name: 'Family Pack',
      description: 'Four General tickets plus a combo meal voucher at a fixed price.',
      pricingKind: 'FIXED',
      priceMinor: general.priceMinor * 4 - 20_000,
      maxPerOrder: 2,
      enabled: true,
      items: {
        create: [
          { ticketTypeId: general.id, quantity: 4 },
          { addOnId: addOns['Combo Meal Voucher'], quantity: 1 },
        ],
      },
    },
  });

  console.log(
    `Demo commerce seeded on "${event.title}" (${event.slug}): ${addOnDefs.length} add-ons + 2 bundles.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
