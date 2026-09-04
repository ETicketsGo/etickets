/* eslint-disable no-console */
import { randomBytes } from 'node:crypto';
import {
  BookingStatus,
  CheckInResultType,
  CouponType,
  EventStatus,
  ExperienceType,
  FeeMode,
  MemberStatus,
  MovieStatus,
  NotificationType,
  OrganizationStatus,
  PaymentAttemptStatus,
  PaymentEnv,
  PaymentProviderMode,
  PaymentStatus,
  PayoutStatus,
  PrismaClient,
  RefundStatus,
  Role,
  SessionStatus,
  TicketStatus,
} from '@prisma/client';
import { routesFor } from './payment-routing-policy';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SEED_PASSWORD = 'Password123!';

/**
 * Booking-fee bands per currency. Amounts are integer MINOR units throughout (paise, cents),
 * so 500 is ₹5 in INR and $5.00 in USD — the same number meaning very different sums, which
 * is precisely why PricingService resolves tiers filtered by currency.
 *
 * The INR bands are the original India defaults and are unchanged. The USD/CAD/AUD bands
 * mirror their shape (four tiers, flat fee rising with subtotal, top band open-ended) at
 * amounts that are sane for those markets rather than a currency conversion of the rupee
 * figures. They are STARTING POINTS for QA, not commercially agreed pricing — expect finance
 * to set the real numbers through the admin console before any of these markets goes live.
 */
const FEE_TIERS_BY_CURRENCY: Record<
  string,
  { label: string; minMinor: number; maxMinor: number | null; feeMinor: number }[]
> = {
  INR: [
    { label: '₹0–₹199', minMinor: 0, maxMinor: 19_900, feeMinor: 500 },
    { label: '₹200–₹499', minMinor: 20_000, maxMinor: 49_900, feeMinor: 1_000 },
    { label: '₹500–₹999', minMinor: 50_000, maxMinor: 99_900, feeMinor: 1_500 },
    { label: '₹1000+', minMinor: 100_000, maxMinor: null, feeMinor: 2_000 },
  ],
  USD: [
    { label: '$0–$9.99', minMinor: 0, maxMinor: 999, feeMinor: 49 },
    { label: '$10–$24.99', minMinor: 1_000, maxMinor: 2_499, feeMinor: 99 },
    { label: '$25–$49.99', minMinor: 2_500, maxMinor: 4_999, feeMinor: 149 },
    { label: '$50+', minMinor: 5_000, maxMinor: null, feeMinor: 199 },
  ],
  CAD: [
    { label: 'C$0–$9.99', minMinor: 0, maxMinor: 999, feeMinor: 59 },
    { label: 'C$10–$24.99', minMinor: 1_000, maxMinor: 2_499, feeMinor: 119 },
    { label: 'C$25–$49.99', minMinor: 2_500, maxMinor: 4_999, feeMinor: 179 },
    { label: 'C$50+', minMinor: 5_000, maxMinor: null, feeMinor: 239 },
  ],
  AUD: [
    { label: 'A$0–$9.99', minMinor: 0, maxMinor: 999, feeMinor: 59 },
    { label: 'A$10–$24.99', minMinor: 1_000, maxMinor: 2_499, feeMinor: 119 },
    { label: 'A$25–$49.99', minMinor: 2_500, maxMinor: 4_999, feeMinor: 179 },
    { label: 'A$50+', minMinor: 5_000, maxMinor: null, feeMinor: 239 },
  ],
};

/** The seed's own price maths is INR-only; keep that path pointed at the INR bands. */
const FEE_TIERS = FEE_TIERS_BY_CURRENCY.INR;

function bookingFee(subtotal: number): number {
  for (const t of FEE_TIERS) {
    if (subtotal >= t.minMinor && (t.maxMinor === null || subtotal <= t.maxMinor))
      return t.feeMinor;
  }
  return FEE_TIERS[FEE_TIERS.length - 1].feeMinor;
}

function computeFees(subtotal: number, feeMode: FeeMode) {
  const bf = subtotal === 0 ? 0 : bookingFee(subtotal);
  const pf = Math.round((200 * (subtotal + bf)) / 10_000);
  const fees = bf + pf;
  let customerFee = 0;
  let organizerFee = 0;
  if (feeMode === FeeMode.CUSTOMER_PAYS) customerFee = fees;
  else if (feeMode === FeeMode.ORGANIZER_PAYS) organizerFee = fees;
  else {
    customerFee = Math.ceil(fees / 2);
    organizerFee = fees - customerFee;
  }
  return {
    bookingFeeMinor: bf,
    paymentFeeMinor: pf,
    customerFeeMinor: customerFee,
    organizerFeeMinor: organizerFee,
    totalMinor: subtotal + customerFee,
  };
}

const rid = (n = 6) => randomBytes(n).toString('hex').toUpperCase();
const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

/**
 * Empty every table this database owns, then let the seed refill it.
 *
 * ── WHY THIS IS NOT A LIST OF deleteMany CALLS ANY MORE ────────────────────────────
 * It used to be, in hand-maintained foreign-key order. That list was correct when written
 * and rotted silently as the schema grew: by the time it was replaced, SEVENTEEN models held
 * foreign keys into rows it deleted and were absent from it — AccountInvitation, AdminGrant,
 * Settlement, Dispute, Review, AddOn, Bundle among them.
 *
 * The failure is not cosmetic. `user.deleteMany()` threw on AccountInvitation's foreign key
 * AFTER thirty-eight earlier deletions had already committed, leaving a QA environment
 * emptied of its events, bookings and payment configuration and unable to reseed itself.
 * Observed on QA, not hypothetical.
 *
 * Enumerating tables by hand is a maintenance promise nobody keeps across eighty models.
 * Asking the database which tables exist keeps working when the next model is added, and one
 * CASCADE makes the ordering question disappear rather than answering it again each time.
 *
 * `_prisma_migrations` is excluded: it records which migrations have run, so emptying it
 * would make an up-to-date database claim it needs every migration from the beginning.
 */
async function reset() {
  // A seed that resets is a data-destroying program. It has no business running anywhere
  // people's money lives — and until this was added, nothing whatsoever stopped it.
  const appEnv = (process.env.APP_ENV ?? '').toLowerCase();
  if (appEnv === 'production' || appEnv === 'prod') {
    throw new Error(
      `Refusing to run: APP_ENV is "${process.env.APP_ENV}". This seed empties every table ` +
        'in the database. It is for local, QA and UAT only.',
    );
  }

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;

  // Quoted, because Prisma's table names are PascalCase and Postgres folds unquoted
  // identifiers to lower case — which would make every one of them "does not exist".
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  console.log(`  reset ${tables.length} tables`);
}

/**
 * Editable runtime payment configuration (ADR-020). Secrets are stored ONLY as
 * references — the placeholder `*_replace_me` public keys and disabled real-provider
 * configs are deliberately safe: they cannot process real money until an admin fills
 * real credentials and enables them. LOCAL/DEV/QA use the simulated dummy provider.
 */
async function seedPaymentPlatform() {
  const localEnvs = [PaymentEnv.LOCAL, PaymentEnv.DEV, PaymentEnv.QA];
  const liveEnvs = [PaymentEnv.STAGING, PaymentEnv.PRODUCTION];

  // 1) Provider configs. Dummy is enabled in the local family; real providers are
  //    seeded disabled with secret REFERENCES so they can be wired up per env.
  const dummyConfigs = localEnvs.map((env) => ({
    env,
    provider: 'dummy',
    enabled: true,
    mode: PaymentProviderMode.DUMMY,
    priority: 10,
  }));
  const realConfigs = [
    // UAT — sandbox (TEST) keys.
    ...['razorpay', 'stripe'].map((provider) => ({
      env: PaymentEnv.UAT,
      provider,
      enabled: false,
      mode: PaymentProviderMode.TEST,
      publicKey: provider === 'razorpay' ? 'rzp_test_replace_me' : 'pk_test_replace_me',
      secretKeyRef: `payments/${provider}/test/secret-key`,
      webhookSecretRef: `payments/${provider}/test/webhook-secret`,
      priority: 20,
    })),
    // STAGING / PRODUCTION — LIVE keys, disabled until real credentials are wired.
    ...liveEnvs.flatMap((env) =>
      ['razorpay', 'stripe'].map((provider) => ({
        env,
        provider,
        enabled: false,
        mode: PaymentProviderMode.LIVE,
        publicKey: provider === 'razorpay' ? 'rzp_live_replace_me' : 'pk_live_replace_me',
        secretKeyRef: `payments/${provider}/${env.toLowerCase()}/secret-key`,
        webhookSecretRef: `payments/${provider}/${env.toLowerCase()}/webhook-secret`,
        priority: 20,
      })),
    ),
  ];

  for (const cfg of [...dummyConfigs, ...realConfigs]) {
    const config = await prisma.paymentProviderConfig.upsert({
      where: { env_provider: { env: cfg.env, provider: cfg.provider } },
      update: cfg,
      create: cfg,
    });
    // One catch-all merchant account per config (country/currency = any).
    await prisma.merchantAccount.create({
      data: {
        configId: config.id,
        label: `${cfg.provider} ${cfg.env.toLowerCase()} settlement`,
        merchantIdRef: cfg.provider === 'dummy' ? null : `payments/${cfg.provider}/merchant-id`,
      },
    });
  }

  // 2) Editable routing policy. Local family routes everything to dummy; higher
  //    envs route India→Razorpay (failover Stripe) and everything else→Stripe.
  /*
    Routing policy is SHARED with `prisma/payment-routes.ts`, the idempotent bootstrap used
    on deployed environments. This file deletes every payment route before it runs; that one
    only upserts. If the two described routing separately they would eventually disagree,
    and the disagreement would surface as a checkout with no provider.
  */
  const routes = [...localEnvs, ...[PaymentEnv.UAT, ...liveEnvs]].flatMap(routesFor);

  for (const route of routes) {
    await prisma.paymentRoute.upsert({
      where: {
        env_country_currency_method: {
          env: route.env,
          country: route.country,
          currency: route.currency,
          method: route.method,
        },
      },
      update: route,
      create: route,
    });
  }
}

async function main() {
  console.log('Resetting existing data...');
  await reset();

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  console.log('Seeding fee rules & coupons...');
  await prisma.feeRule.createMany({
    data: Object.entries(FEE_TIERS_BY_CURRENCY).flatMap(([currency, tiers]) =>
      tiers.map((t) => ({ ...t, currency })),
    ),
  });

  console.log('Seeding payment platform (providers, routes, merchants)...');
  await seedPaymentPlatform();
  await prisma.coupon.createMany({
    data: [
      { code: 'WELCOME10', type: CouponType.PERCENT, value: 10, maxRedemptions: 1000 },
      { code: 'FLAT50', type: CouponType.FIXED, value: 5_000, maxRedemptions: 500 },
    ],
  });

  console.log('Seeding users...');
  const admin = await prisma.user.create({
    data: {
      email: 'admin@eticketsgo.test',
      passwordHash,
      fullName: 'Aditi Admin',
      roles: [Role.ADMIN, Role.SUPER_ADMIN],
    },
  });
  const owner = await prisma.user.create({
    data: {
      email: 'owner@eticketsgo.test',
      passwordHash,
      fullName: 'Omar Organizer',
      roles: [Role.ORGANIZER_OWNER, Role.CUSTOMER],
    },
  });
  const manager = await prisma.user.create({
    data: {
      email: 'manager@eticketsgo.test',
      passwordHash,
      fullName: 'Meera Manager',
      roles: [Role.ORGANIZER_MANAGER],
    },
  });
  const staff = await prisma.user.create({
    data: {
      email: 'checkin@eticketsgo.test',
      passwordHash,
      fullName: 'Sam Staff',
      roles: [Role.CHECKIN_STAFF],
    },
  });
  const customer1 = await prisma.user.create({
    data: {
      email: 'customer1@eticketsgo.test',
      passwordHash,
      fullName: 'Riya Rao',
      roles: [Role.CUSTOMER],
    },
  });
  const customer2 = await prisma.user.create({
    data: {
      email: 'customer2@eticketsgo.test',
      passwordHash,
      fullName: 'Karan Kumar',
      roles: [Role.CUSTOMER],
    },
  });

  console.log('Seeding organization & members...');
  const org = await prisma.organization.create({
    data: {
      name: 'Bengaluru Live',
      slug: 'bengaluru-live',
      status: OrganizationStatus.APPROVED,
      contactEmail: 'hello@bengaluru-live.test',
      members: {
        create: [
          { userId: owner.id, role: Role.ORGANIZER_OWNER, status: MemberStatus.ACTIVE },
          { userId: manager.id, role: Role.ORGANIZER_MANAGER, status: MemberStatus.ACTIVE },
          { userId: staff.id, role: Role.CHECKIN_STAFF, status: MemberStatus.ACTIVE },
        ],
      },
    },
  });

  console.log('Seeding venues...');
  const arena = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: 'Phoenix Arena',
      city: 'Bengaluru',
      country: 'India',
      address: 'Whitefield, Bengaluru, KA',
      capacity: 5000,
      areas: {
        create: [
          { name: 'General', capacity: 4000 },
          { name: 'VIP', capacity: 1000 },
        ],
      },
    },
  });
  const dome = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: 'NSCI Dome',
      city: 'Mumbai',
      country: 'India',
      address: 'Worli, Mumbai, MH',
      capacity: 8000,
    },
  });

  console.log('Seeding events, sessions, ticket types...');
  const eventDefs = [
    {
      title: 'Sunburn Arena — Bengaluru',
      category: 'Music',
      status: EventStatus.PUBLISHED,
      venue: arena,
    },
    { title: 'DevConf India 2026', category: 'Tech', status: EventStatus.PUBLISHED, venue: dome },
    {
      title: 'Standup Night with Zomato Comedy',
      category: 'Comedy',
      status: EventStatus.PUBLISHED,
      venue: arena,
    },
    {
      title: 'Premier Kabaddi Finals',
      category: 'Sports',
      status: EventStatus.UNDER_REVIEW,
      venue: dome,
    },
    {
      title: 'Hamlet — The Immersive Play',
      category: 'Theatre',
      status: EventStatus.DRAFT,
      venue: arena,
    },
    /*
      One event that costs nothing, so the free path is reachable in a seeded environment.

      Free is not a price of zero — it changes what the platform DOES: no payment provider is
      called, no booking fee and no platform share are taken, and the buyer never sees a
      checkout. Without a seeded example, the only way to exercise any of that in QA is to
      build an event by hand first.
    */
    {
      title: 'Community Open Day',
      category: 'Community',
      status: EventStatus.PUBLISHED,
      venue: dome,
      isFree: true,
    },
  ];

  const createdEvents: {
    id: string;
    sessionId: string;
    ticketTypes: { id: string; price: number }[];
  }[] = [];

  for (const [i, def] of eventDefs.entries()) {
    const slug = def.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const event = await prisma.event.create({
      data: {
        organizationId: org.id,
        venueId: def.venue.id,
        title: def.title,
        slug,
        category: def.category,
        description: `${def.title} — an unmissable ${def.category.toLowerCase()} experience presented by Bengaluru Live.`,
        status: def.status,
        feeMode: i % 2 === 0 ? FeeMode.CUSTOMER_PAYS : FeeMode.SHARED,
        isFree: def.isFree ?? false,
        refundPolicy: 'Full refund up to 48 hours before the session. No refunds after.',
        publishedAt: def.status === EventStatus.PUBLISHED ? new Date() : null,
      },
    });

    const session = await prisma.eventSession.create({
      data: {
        eventId: event.id,
        startsAt: days(10 + i),
        endsAt: days(10 + i),
        status: SessionStatus.SCHEDULED,
      },
    });

    /*
      A free event's tiers are all zero, and one tier is enough.

      Not a cosmetic choice: the API refuses a priced ticket type on a free event, so seeding
      Gold and VIP here would fail outright — and tiers are a way of charging different people
      different amounts, which is a question a free event does not have.
    */
    const tierDefs = def.isFree
      ? [{ name: 'Free entry', priceMinor: 0, quantityTotal: 300 }]
      : [
          { name: 'General', priceMinor: 79_900, quantityTotal: 500 },
          { name: 'Gold', priceMinor: 149_900, quantityTotal: 200 },
          { name: 'VIP', priceMinor: 299_900, quantityTotal: 50 },
        ];
    const ticketTypes: { id: string; price: number }[] = [];
    for (const t of tierDefs) {
      const tt = await prisma.ticketType.create({
        data: {
          eventSessionId: session.id,
          name: t.name,
          priceMinor: t.priceMinor,
          quantityTotal: t.quantityTotal,
          maxPerOrder: 10,
          salesStartAt: new Date(),
          salesEndAt: days(9 + i),
          inventory: {
            create: { quantityTotal: t.quantityTotal, quantitySold: 0, quantityHeld: 0 },
          },
        },
      });
      ticketTypes.push({ id: tt.id, price: t.priceMinor });
    }
    createdEvents.push({ id: event.id, sessionId: session.id, ticketTypes });
  }

  // ── Movie catalogue (PR-2): movies are NOT customer-bookable yet (PR-3). ──
  console.log('Seeding movies & cinemas (catalogue only)...');
  const movieDefs = [
    {
      title: 'Skyfront Protocol',
      synopsis:
        'An off-grid pilot is pulled back for one last mission when a rogue drone swarm threatens the coast.',
      runtimeMinutes: 138,
      certificate: 'UA',
      language: 'English',
      genres: ['Action', 'Thriller'],
      cast: ['Arjun Mehra', 'Lena Fischer', 'Dev Anand Rao'],
      director: 'Priya Nair',
      posterUrl: 'https://cdn.eticketsgo.test/posters/skyfront-protocol.jpg',
      trailerUrl: 'https://videos.eticketsgo.test/trailers/skyfront-protocol.mp4',
    },
    {
      title: 'The Weight of Water',
      synopsis:
        'A quiet drama about a fishing family navigating loss across three generations on the Konkan coast.',
      runtimeMinutes: 124,
      certificate: 'U',
      language: 'Hindi',
      genres: ['Drama'],
      cast: ['Meera Joshi', 'Rahul Verma'],
      director: 'Anil Kapoor Menon',
      posterUrl: 'https://cdn.eticketsgo.test/posters/weight-of-water.jpg',
    },
    {
      title: 'Pixel & the Paper Moon',
      synopsis:
        'A curious robot and a runaway kite set off across a hand-drawn world to find where the sky ends.',
      runtimeMinutes: 96,
      certificate: 'U',
      language: 'English',
      genres: ['Animation', 'Family', 'Adventure'],
      cast: ['Tara Iyer', 'Sam Okoye'],
      director: 'Yuki Tanaka',
      posterUrl: 'https://cdn.eticketsgo.test/posters/pixel-paper-moon.jpg',
      trailerUrl: 'https://videos.eticketsgo.test/trailers/pixel-paper-moon.mp4',
    },
  ];
  const movies = [];
  for (const [i, def] of movieDefs.entries()) {
    const slug = def.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const movie = await prisma.movie.create({
      data: {
        organizationId: org.id,
        title: def.title,
        slug,
        synopsis: def.synopsis,
        runtimeMinutes: def.runtimeMinutes,
        certificate: def.certificate,
        language: def.language,
        genres: def.genres,
        cast: def.cast,
        director: def.director,
        posterUrl: def.posterUrl,
        trailerUrl: def.trailerUrl,
        releaseDate: days(-30 + i * 7),
        status: MovieStatus.PUBLISHED,
      },
    });
    movies.push(movie);
  }
  // The first movie is made fully bookable below (seat map + shows).
  const bookableMovie = movies[0];

  const cinema = await prisma.cinema.create({
    data: {
      organizationId: org.id,
      venueId: arena.id,
      name: 'PVR Phoenix Whitefield',
      brand: 'PVR',
      city: 'Bengaluru',
      address: 'Phoenix Marketcity, Whitefield, Bengaluru, KA',
      latitude: 12.9959,
      longitude: 77.6969,
      screens: {
        create: [
          { name: 'Screen 1', screenType: 'IMAX', capacity: 320 },
          { name: 'Screen 2', screenType: '2D', capacity: 180 },
        ],
      },
    },
    include: { screens: { orderBy: { name: 'asc' } } },
  });
  const bookableScreen = cinema.screens[0];

  // ── Bookable movie (PR-3): generate a seat map, then schedule 2 shows. ──
  console.log('Seeding seat map & movie shows (bookable)...');
  const seatSections = [
    {
      name: 'Normal',
      categoryName: 'Normal',
      colorHex: '#38bdf8',
      basePriceMinor: 20_000,
      rowLabels: ['A', 'B', 'C', 'D'],
      seatsPerRow: 12,
    },
    {
      name: 'Premium',
      categoryName: 'Premium',
      colorHex: '#a78bfa',
      basePriceMinor: 30_000,
      rowLabels: ['E', 'F'],
      seatsPerRow: 12,
    },
    {
      name: 'Recliner',
      categoryName: 'Recliner',
      colorHex: '#f59e0b',
      basePriceMinor: 45_000,
      rowLabels: ['G'],
      seatsPerRow: 8,
    },
  ];
  const seatMap = await prisma.seatMap.create({
    data: { screenId: bookableScreen.id, name: 'Main Auditorium' },
  });
  for (const [i, section] of seatSections.entries()) {
    const category = await prisma.seatCategory.create({
      data: {
        seatMapId: seatMap.id,
        name: section.categoryName,
        colorHex: section.colorHex,
        basePriceMinor: section.basePriceMinor,
        sortOrder: i,
      },
    });
    const seatSection = await prisma.seatSection.create({
      data: { seatMapId: seatMap.id, name: section.name, sortOrder: i },
    });
    for (const [rowIndex, rowLabel] of section.rowLabels.entries()) {
      const row = await prisma.seatRow.create({
        data: { sectionId: seatSection.id, label: rowLabel, sortOrder: rowIndex },
      });
      await prisma.seat.createMany({
        data: Array.from({ length: section.seatsPerRow }, (_unused, k) => ({
          seatMapId: seatMap.id,
          rowId: row.id,
          seatCategoryId: category.id,
          label: String(k + 1),
          colIndex: k + 1,
          kind: 'SEAT',
        })),
      });
    }
  }

  const fullSeatMap = await prisma.seatMap.findUniqueOrThrow({
    where: { id: seatMap.id },
    include: { categories: { orderBy: { sortOrder: 'asc' } }, seats: true },
  });

  // One movie Event (PUBLISHED => bookable) with two future shows on the screen.
  const movieEvent = await prisma.event.create({
    data: {
      organizationId: org.id,
      venueId: cinema.venueId ?? arena.id,
      experienceType: ExperienceType.MOVIE,
      movieId: bookableMovie.id,
      title: bookableMovie.title,
      slug: `${bookableMovie.slug}-show-${rid(3).toLowerCase()}`,
      category: 'Movie',
      status: EventStatus.PUBLISHED,
      publishedAt: new Date(),
    },
  });

  for (const startsAt of [days(2), days(5)]) {
    const endsAt = new Date(startsAt.getTime() + bookableMovie.runtimeMinutes * 60_000);
    const session = await prisma.eventSession.create({
      data: {
        eventId: movieEvent.id,
        screenId: bookableScreen.id,
        // Pin the layout version, exactly as scheduleShow does.
        seatMapId: seatMap.id,
        startsAt,
        endsAt,
        status: SessionStatus.SCHEDULED,
      },
    });
    for (const category of fullSeatMap.categories) {
      const quantityTotal = fullSeatMap.seats.filter(
        (s) => s.seatCategoryId === category.id,
      ).length;
      await prisma.ticketType.create({
        data: {
          eventSessionId: session.id,
          seatCategoryId: category.id,
          name: category.name,
          priceMinor: category.basePriceMinor,
          currency: 'INR',
          quantityTotal,
          maxPerOrder: 10,
          status: 'ACTIVE',
          inventory: { create: { quantityTotal, quantitySold: 0, quantityHeld: 0 } },
        },
      });
    }
    await prisma.showSeat.createMany({
      data: fullSeatMap.seats.map((s) => ({
        eventSessionId: session.id,
        seatId: s.id,
        status: 'AVAILABLE',
      })),
    });
  }

  console.log('Seeding bookings, payments, tickets, check-ins...');
  const musicEvent = createdEvents[0];
  const generalType = musicEvent.ticketTypes[0];

  // Confirmed booking for customer1 with 2 tickets (one will be checked in).
  const subtotal1 = generalType.price * 2;
  const fees1 = computeFees(subtotal1, FeeMode.CUSTOMER_PAYS);
  const booking1 = await prisma.booking.create({
    data: {
      organizationId: org.id,
      eventId: musicEvent.id,
      eventSessionId: musicEvent.sessionId,
      userId: customer1.id,
      buyerName: customer1.fullName,
      buyerEmail: customer1.email,
      status: BookingStatus.CONFIRMED,
      feeMode: FeeMode.CUSTOMER_PAYS,
      subtotalMinor: subtotal1,
      ...fees1,
      holdExpiresAt: new Date(),
      confirmedAt: new Date(),
      items: {
        create: [
          {
            ticketTypeId: generalType.id,
            quantity: 2,
            unitPriceMinor: generalType.price,
            lineTotalMinor: subtotal1,
          },
        ],
      },
      payment: {
        create: {
          provider: 'mock',
          status: PaymentStatus.SUCCEEDED,
          amountMinor: fees1.totalMinor,
          providerRef: `mock_${rid()}`,
          attempts: {
            create: [{ status: PaymentAttemptStatus.SUCCEEDED, providerRef: `mock_${rid()}` }],
          },
        },
      },
    },
  });
  await prisma.ticketInventory.update({
    where: { ticketTypeId: generalType.id },
    data: { quantitySold: { increment: 2 } },
  });
  const t1 = await prisma.ticket.create({
    data: {
      bookingId: booking1.id,
      ticketTypeId: generalType.id,
      eventSessionId: musicEvent.sessionId,
      organizationId: org.id,
      serial: `TKT-${rid()}`,
      nonce: rid(8),
      status: TicketStatus.CHECKED_IN,
      holderName: customer1.fullName,
      holderEmail: customer1.email,
    },
  });
  await prisma.ticket.create({
    data: {
      bookingId: booking1.id,
      ticketTypeId: generalType.id,
      eventSessionId: musicEvent.sessionId,
      organizationId: org.id,
      serial: `TKT-${rid()}`,
      nonce: rid(8),
      status: TicketStatus.ACTIVE,
      holderName: customer1.fullName,
      holderEmail: customer1.email,
    },
  });
  await prisma.checkIn.create({
    data: {
      ticketId: t1.id,
      eventSessionId: musicEvent.sessionId,
      result: CheckInResultType.SUCCESS,
      byUserId: staff.id,
      deviceInfo: 'Gate A scanner',
    },
  });
  await prisma.notification.create({
    data: {
      userId: customer1.id,
      type: NotificationType.BOOKING_CONFIRMED,
      toEmail: customer1.email,
      payload: { bookingId: booking1.id, tickets: 2 },
      status: 'SENT',
      sentAt: new Date(),
    },
  });

  // Pending booking for customer1 (hold still active).
  const pendingSubtotal = generalType.price;
  const pendingFees = computeFees(pendingSubtotal, FeeMode.CUSTOMER_PAYS);
  await prisma.booking.create({
    data: {
      organizationId: org.id,
      eventId: musicEvent.id,
      eventSessionId: musicEvent.sessionId,
      userId: customer1.id,
      buyerName: customer1.fullName,
      buyerEmail: customer1.email,
      status: BookingStatus.PENDING_PAYMENT,
      feeMode: FeeMode.CUSTOMER_PAYS,
      subtotalMinor: pendingSubtotal,
      ...pendingFees,
      holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      items: {
        create: [
          {
            ticketTypeId: generalType.id,
            quantity: 1,
            unitPriceMinor: generalType.price,
            lineTotalMinor: pendingSubtotal,
          },
        ],
      },
      payment: {
        create: {
          provider: 'mock',
          status: PaymentStatus.REQUIRES_PAYMENT,
          amountMinor: pendingFees.totalMinor,
        },
      },
    },
  });
  await prisma.ticketInventory.update({
    where: { ticketTypeId: generalType.id },
    data: { quantityHeld: { increment: 1 } },
  });

  // Confirmed booking for customer2 with a refunded ticket (partially refunded).
  const techEvent = createdEvents[1];
  const techType = techEvent.ticketTypes[1];
  const subtotal2 = techType.price * 2;
  const fees2 = computeFees(subtotal2, FeeMode.SHARED);
  const booking2 = await prisma.booking.create({
    data: {
      organizationId: org.id,
      eventId: techEvent.id,
      eventSessionId: techEvent.sessionId,
      userId: customer2.id,
      buyerName: customer2.fullName,
      buyerEmail: customer2.email,
      status: BookingStatus.PARTIALLY_REFUNDED,
      feeMode: FeeMode.SHARED,
      subtotalMinor: subtotal2,
      ...fees2,
      holdExpiresAt: new Date(),
      confirmedAt: new Date(),
      items: {
        create: [
          {
            ticketTypeId: techType.id,
            quantity: 2,
            unitPriceMinor: techType.price,
            lineTotalMinor: subtotal2,
          },
        ],
      },
      payment: {
        create: {
          provider: 'mock',
          status: PaymentStatus.PARTIALLY_REFUNDED,
          amountMinor: fees2.totalMinor,
          providerRef: `mock_${rid()}`,
          attempts: {
            create: [{ status: PaymentAttemptStatus.SUCCEEDED, providerRef: `mock_${rid()}` }],
          },
        },
      },
    },
  });
  await prisma.ticketInventory.update({
    where: { ticketTypeId: techType.id },
    data: { quantitySold: { increment: 2 } },
  });
  const refundedTicket = await prisma.ticket.create({
    data: {
      bookingId: booking2.id,
      ticketTypeId: techType.id,
      eventSessionId: techEvent.sessionId,
      organizationId: org.id,
      serial: `TKT-${rid()}`,
      nonce: rid(8),
      status: TicketStatus.REFUNDED,
      holderName: customer2.fullName,
      holderEmail: customer2.email,
    },
  });
  await prisma.ticket.create({
    data: {
      bookingId: booking2.id,
      ticketTypeId: techType.id,
      eventSessionId: techEvent.sessionId,
      organizationId: org.id,
      serial: `TKT-${rid()}`,
      nonce: rid(8),
      status: TicketStatus.ACTIVE,
      holderName: customer2.fullName,
      holderEmail: customer2.email,
    },
  });
  await prisma.refund.create({
    data: {
      bookingId: booking2.id,
      organizationId: org.id,
      amountMinor: techType.price,
      status: RefundStatus.COMPLETED,
      reason: 'Customer could not attend one seat.',
      ticketIds: [refundedTicket.id],
      requestedByUserId: customer2.id,
      processedByUserId: admin.id,
      providerRef: `mock_rf_${rid()}`,
    },
  });

  // Cancelled/expired booking for customer2.
  await prisma.booking.create({
    data: {
      organizationId: org.id,
      eventId: techEvent.id,
      eventSessionId: techEvent.sessionId,
      userId: customer2.id,
      buyerName: customer2.fullName,
      buyerEmail: customer2.email,
      status: BookingStatus.EXPIRED,
      feeMode: FeeMode.SHARED,
      subtotalMinor: techType.price,
      ...computeFees(techType.price, FeeMode.SHARED),
      holdExpiresAt: new Date(Date.now() - 60 * 1000),
      items: {
        create: [
          {
            ticketTypeId: techType.id,
            quantity: 1,
            unitPriceMinor: techType.price,
            lineTotalMinor: techType.price,
          },
        ],
      },
    },
  });

  console.log('Seeding payout & audit logs...');
  await prisma.payout.create({
    data: {
      organizationId: org.id,
      eventId: musicEvent.id,
      periodStart: days(-7),
      periodEnd: new Date(),
      grossMinor: subtotal1,
      bookingFeeMinor: fees1.bookingFeeMinor,
      paymentFeeMinor: fees1.paymentFeeMinor,
      refundMinor: 0,
      netMinor: subtotal1 - fees1.organizerFeeMinor,
      status: PayoutStatus.PENDING,
      scheduledAt: days(7),
    },
  });
  await prisma.auditLog.createMany({
    data: [
      {
        actorUserId: admin.id,
        organizationId: org.id,
        action: 'ORGANIZATION_APPROVED',
        entityType: 'Organization',
        entityId: org.id,
      },
      {
        actorUserId: staff.id,
        organizationId: org.id,
        action: 'TICKET_CHECKED_IN',
        entityType: 'Ticket',
        entityId: t1.id,
      },
      {
        actorUserId: admin.id,
        organizationId: org.id,
        action: 'REFUND_COMPLETED',
        entityType: 'Booking',
        entityId: booking2.id,
      },
    ],
  });

  console.log('Seeding reviews...');
  await prisma.review.createMany({
    data: [
      {
        eventId: musicEvent.id,
        userId: customer1.id,
        rating: 5,
        comment: 'Incredible night — entry was seamless with the QR ticket. Will book again!',
      },
      {
        eventId: techEvent.id,
        userId: customer2.id,
        rating: 4,
        comment: 'Great talks and well organised. Venue could use more seating.',
      },
    ],
  });

  console.log('\nSeed complete. Login with password: ' + SEED_PASSWORD);
  console.table([
    { role: 'ADMIN / SUPER_ADMIN', email: admin.email },
    { role: 'ORGANIZER_OWNER', email: owner.email },
    { role: 'ORGANIZER_MANAGER', email: manager.email },
    { role: 'CHECKIN_STAFF', email: staff.email },
    { role: 'CUSTOMER', email: customer1.email },
    { role: 'CUSTOMER', email: customer2.email },
  ]);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
