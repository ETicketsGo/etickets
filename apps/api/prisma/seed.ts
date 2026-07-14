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
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SEED_PASSWORD = 'Password123!';

const FEE_TIERS = [
  { label: '₹0–₹199', minMinor: 0, maxMinor: 19_900, feeMinor: 500 },
  { label: '₹200–₹499', minMinor: 20_000, maxMinor: 49_900, feeMinor: 1_000 },
  { label: '₹500–₹999', minMinor: 50_000, maxMinor: 99_900, feeMinor: 1_500 },
  { label: '₹1000+', minMinor: 100_000, maxMinor: null, feeMinor: 2_000 },
];

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

async function reset() {
  // Delete in FK-safe order.
  await prisma.checkIn.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.paymentAttempt.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.bookingItem.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.ticketInventory.deleteMany();
  await prisma.ticketType.deleteMany();
  await prisma.showSeat.deleteMany();
  await prisma.eventSession.deleteMany();
  await prisma.event.deleteMany();
  await prisma.seat.deleteMany();
  await prisma.seatRow.deleteMany();
  await prisma.seatSection.deleteMany();
  await prisma.seatCategory.deleteMany();
  await prisma.seatMap.deleteMany();
  await prisma.screen.deleteMany();
  await prisma.cinema.deleteMany();
  await prisma.movie.deleteMany();
  await prisma.venueArea.deleteMany();
  await prisma.venue.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.feeRule.deleteMany();
  await prisma.merchantAccount.deleteMany();
  await prisma.paymentProviderConfig.deleteMany();
  await prisma.paymentRoute.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.user.deleteMany();
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
  const dummyRoutes = localEnvs.map((env) => ({
    env,
    country: '*',
    currency: '*',
    method: '*',
    provider: 'dummy',
    priority: 100,
  }));
  const realRoutes = [PaymentEnv.UAT, ...liveEnvs].flatMap((env) => [
    // INR settles via Razorpay (failover Stripe); everything else via Stripe.
    // Currency-based so it routes without depending on venue country formatting.
    {
      env,
      country: '*',
      currency: 'INR',
      method: '*',
      provider: 'razorpay',
      failoverProvider: 'stripe',
      priority: 10,
    },
    { env, country: '*', currency: '*', method: '*', provider: 'stripe', priority: 100 },
  ]);

  for (const route of [...dummyRoutes, ...realRoutes]) {
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
  await prisma.feeRule.createMany({ data: FEE_TIERS });

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

    const tierDefs = [
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
