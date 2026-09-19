import { GuestBookingService, maskEmail } from './guest-booking.service';
import { guestAccessExpiry, hashGuestAccessToken } from './guest-access';
import { AnonymousSessionService } from './orchestration/booking-owner';
import { GuestSessionVerifier } from './guest-session';

/**
 * What somebody who bought without an account may see, and what they may not.
 *
 * ── WHY EVERY TEST HERE IS ABOUT A REFUSAL ─────────────────────────────────────────
 * The happy path of these routes is one query and a projection; it is the failures that carry
 * the risk, and all of them are silent. A guest route that reads an account booking, a masked
 * address that is not masked, a lookup form that answers differently for a real reference — none
 * of those throws, logs, or looks wrong in a response somebody is reading casually. Each is a
 * leak that works.
 */

const NOW = new Date('2026-09-18T10:00:00.000Z');

const CONFIRMED_BOOKING = {
  id: 'bk-1',
  userId: null,
  reference: 'ETG-IND-2026-000123',
  status: 'CONFIRMED',
  currency: 'INR',
  holdExpiresAt: new Date('2026-09-18T10:10:00.000Z'),
  createdAt: new Date('2026-09-18T09:50:00.000Z'),
  buyerName: 'Bobby Tables',
  buyerEmail: 'bobby.tables@example.com',
  subtotalMinor: 50000,
  customerFeeMinor: 3000,
  taxMinor: 1500,
  totalMinor: 54500,
  items: [
    {
      label: null,
      quantity: 2,
      unitPriceMinor: 25000,
      ticketTypeId: 'tt-1',
      ticketType: { name: 'Gold' },
      addOn: null,
      bundle: null,
    },
  ],
  event: {
    title: 'Kantara',
    slug: 'kantara',
    venue: { name: 'PVR Forum Mall', timezone: 'Asia/Kolkata' },
  },
  eventSession: {
    startsAt: new Date('2026-09-20T13:30:00.000Z'),
    screen: { name: 'Screen 3', cinema: { name: 'PVR Vijayawada', timezone: 'Asia/Kolkata' } },
  },
  tickets: [
    {
      id: 'tk-1',
      ticketTypeId: 'tt-1',
      seatLabel: 'H1',
      ticketType: { name: 'Gold' },
      seat: null,
      checkIns: [],
    },
    {
      id: 'tk-2',
      ticketTypeId: 'tt-1',
      seatLabel: 'H2',
      ticketType: { name: 'Gold' },
      seat: null,
      checkIns: [{ createdAt: new Date('2026-09-20T13:05:00.000Z') }],
    },
  ],
};

interface Stubs {
  booking?: Record<string, unknown> | null;
  access?: Record<string, unknown> | null;
  /** Decorated tickets, as TicketsService would return them. */
  presented?: { id: string; qrToken: string | null; qrDataUrl: string | null }[];
  active?: boolean;
  workflow?: { ownerType: string | null; ownerId: string | null } | null;
}

/** A collaborator no route in this suite may call, stubbed so that calling it fails loudly. */
const unreachable = (name: string) =>
  jest.fn(() => {
    throw new Error(`${name} must not be reached from a guest READ route`);
  });

function setup(stubs: Stubs = {}) {
  const bookingFindFirst = jest.fn().mockResolvedValue(stubs.booking ?? null);
  const accessFindUnique = jest.fn().mockResolvedValue(stubs.access ?? null);
  const accessUpdate = jest.fn().mockResolvedValue({});
  const accessDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const accessCreate = jest.fn().mockResolvedValue({});
  const send = jest.fn().mockResolvedValue(undefined);
  const ticketsForGuestBooking = jest.fn().mockResolvedValue(stubs.presented ?? []);

  const tx = {
    guestBookingAccess: { deleteMany: accessDeleteMany, create: accessCreate },
  };
  const prisma = {
    booking: { findFirst: bookingFindFirst },
    guestBookingAccess: { findUnique: accessFindUnique, update: accessUpdate },
    $transaction: jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(tx)),
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'BOOKING_ORCHESTRATOR_ENABLED') return stubs.active === true;
      if (key === 'BOOKING_ORCHESTRATOR_MODE') return stubs.active ? 'active' : 'shadow';
      if (key === 'CUSTOMER_WEB_URL') return 'https://tickets.example.com';
      return fallback;
    }),
  };
  const anon = new AnonymousSessionService();
  const workflows = {
    getByBookingId: jest.fn().mockResolvedValue(stubs.workflow ?? null),
  };

  const service = new GuestBookingService(
    prisma as never,
    { ticketsForGuestBooking } as never,
    { send } as never,
    config as never,
    anon,
    /*
      The REAL verifier over the same stubs, not a mock of it: the session binding is the rule these
      suites are about, and a stubbed verifier would assert only that a method was called.
    */
    new GuestSessionVerifier(prisma as never, config as never, workflows as never, anon),
    /*
      Receipts, refunds and the audit log reach the guest routes that need the buyer's ADDRESS as
      well as the link — see guest-self-service.spec.ts. Stubbed to throw here rather than to
      resolve: nothing in this suite may touch a document or move money, and a stub that quietly
      returned would let a future change do so without failing a test.
    */
    { listForBooking: unreachable('listForBooking'), document: unreachable('document') } as never,
    { requestAsGuest: unreachable('requestAsGuest') } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return {
    service,
    anon,
    bookingFindFirst,
    accessFindUnique,
    accessUpdate,
    accessDeleteMany,
    accessCreate,
    send,
    ticketsForGuestBooking,
    workflows,
  };
}

const session = () => new AnonymousSessionService().issueToken();

/**
 * A stored access row for one raw token.
 *
 * The hash is real, not a placeholder: the service verifies the presented token against the
 * stored hash in constant time even though it located the row by that same hash, and a stub
 * with a made-up hash would make that check untestable.
 */
const live = (rawToken: string, expiresAt: Date) => ({
  id: 'ga-1',
  bookingId: 'bk-1',
  expiresAt,
  tokenHash: hashGuestAccessToken(rawToken),
});

describe('the masked buyer address never carries the whole address', () => {
  it('keeps two characters and the domain, and nothing else', () => {
    expect(maskEmail('bobby.tables@example.com')).toBe('bo***@example.com');
  });

  it.each([
    'bobby.tables@example.com',
    'a@b.co',
    'ab@b.co',
    'abc@b.co',
    'x.y+tag@sub.domain.co.uk',
    'UPPER.CASE@Example.COM',
  ])('never contains the local part of %s', (address) => {
    const masked = maskEmail(address);
    const local = address.slice(0, address.lastIndexOf('@'));
    // Never the whole local part — including the short addresses, where two characters would
    // be all of it.
    expect(masked).not.toContain(local);
    expect(masked).not.toContain(address);
    // At most two characters of it survive, whatever the address looks like.
    expect(masked.slice(0, masked.indexOf('***')).length).toBeLessThanOrEqual(2);
  });

  it('reveals nothing at all for a value it cannot parse', () => {
    // A blank or malformed address must not fall through to "print what we have".
    expect(maskEmail('not-an-address')).toBe('***');
    expect(maskEmail('a@b.co')).toBe('***@b.co');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('')).toBe('***');
    expect(maskEmail(null)).toBe('***');
  });

  it('is what the view sends, in place of the buyer’s address', async () => {
    const { service } = setup({ booking: CONFIRMED_BOOKING });
    const view = await service.viewBySession('bk-1', session());
    expect(view.buyer.emailMasked).toBe('bo***@example.com');
    expect(JSON.stringify(view)).not.toContain('bobby.tables@example.com');
  });
});

describe('an account booking is not readable through a guest route', () => {
  it('asks the database for a booking with no owner, rather than filtering afterwards', async () => {
    /*
      The point of asserting the WHERE clause: an account booking must never be read into memory
      in a request that is about to be answered to an anonymous caller. A post-hoc `if` would
      pass a test on the response and still load the row.
    */
    const { service, bookingFindFirst } = setup({ booking: CONFIRMED_BOOKING });
    await service.viewBySession('bk-1', session());
    expect(bookingFindFirst.mock.calls[0][0].where).toEqual({ id: 'bk-1', userId: null });
  });

  it('404s when the id belongs to an account booking', async () => {
    // The stub returns null because the query excluded it, which is the real behaviour.
    const { service } = setup({ booking: null });
    await expect(service.viewBySession('bk-account', session())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses the same way for an account booking and one that does not exist', async () => {
    // Two different 404s would tell a guesser which ids are real and which are somebody's.
    const { service } = setup({ booking: null });
    const account = await service.viewBySession('bk-account', session()).catch((e) => e);
    const missing = await service.viewBySession('bk-nope', session()).catch((e) => e);
    expect(account.status).toBe(missing.status);
    expect(account.message).toBe(missing.message);
  });

  it('never mints an access link for an account booking', async () => {
    const { service, bookingFindFirst, send } = setup({ booking: null });
    await service.requestAccessLink({ reference: 'ETG-IND-2026-000123', email: 'a@b.co' });
    expect(bookingFindFirst.mock.calls[0][0].where.userId).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the guest session is the price of asking', () => {
  it('rejects a token that is not well-formed, before any booking is loaded', async () => {
    const { service, bookingFindFirst } = setup({ booking: CONFIRMED_BOOKING });
    await expect(service.viewBySession('bk-1', 'not-a-session')).rejects.toMatchObject({
      status: 401,
      message: 'A valid guest checkout session is required.',
    });
    await expect(service.viewBySession('bk-1', undefined)).rejects.toMatchObject({ status: 401 });
    expect(bookingFindFirst).not.toHaveBeenCalled();
  });

  it('asserts real ownership against the workflow in active mode', async () => {
    // Holding SOME valid session must not read SOMEBODY ELSE'S guest booking.
    const hasher = new AnonymousSessionService();
    const { service } = setup({
      booking: CONFIRMED_BOOKING,
      active: true,
      workflow: {
        ownerType: 'ANONYMOUS_SESSION',
        ownerId: hasher.hash('anon_someone-elses-session-token'),
      },
    });
    await expect(service.viewBySession('bk-1', session())).rejects.toMatchObject({ status: 403 });
  });

  it('lets the owning session through in active mode', async () => {
    const mine = session();
    const hasher = new AnonymousSessionService();
    const { service } = setup({ booking: CONFIRMED_BOOKING, active: true });
    const withOwner = setup({
      booking: CONFIRMED_BOOKING,
      active: true,
      workflow: { ownerType: 'ANONYMOUS_SESSION', ownerId: hasher.hash(mine) },
    });
    await expect(withOwner.service.viewBySession('bk-1', mine)).resolves.toMatchObject({
      id: 'bk-1',
    });
    // A workflow that does not exist (disabled/shadow history) is not a refusal.
    await expect(service.viewBySession('bk-1', mine)).resolves.toMatchObject({ id: 'bk-1' });
  });
});

describe('the lookup form tells a stranger nothing', () => {
  const found = {
    id: 'bk-1',
    buyerEmail: 'bobby.tables@example.com',
    createdAt: CONFIRMED_BOOKING.createdAt,
    organizationId: 'org-1',
  };

  it('answers identically for a known and an unknown reference', async () => {
    const hit = setup({ booking: found });
    const miss = setup({ booking: null });
    const a = await hit.service.requestAccessLink({
      reference: 'ETG-IND-2026-000123',
      email: 'bobby.tables@example.com',
    });
    const b = await miss.service.requestAccessLink({
      reference: 'ETG-IND-2026-999999',
      email: 'nobody@example.com',
    });
    expect(a).toEqual({ sent: true });
    expect(b).toEqual({ sent: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // And the one that matched really did send, so the sameness is not sameness of doing nothing.
    expect(hit.send).toHaveBeenCalledTimes(1);
    expect(miss.send).not.toHaveBeenCalled();
  });

  it('takes about as long either way, so the timing is not the answer', async () => {
    const hit = setup({ booking: found });
    const miss = setup({ booking: null });
    const time = async (fn: () => Promise<unknown>) => {
      const started = Date.now();
      await fn();
      return Date.now() - started;
    };
    const hitMs = await time(() =>
      hit.service.requestAccessLink({ reference: 'R', email: 'bobby.tables@example.com' }),
    );
    const missMs = await time(() =>
      miss.service.requestAccessLink({ reference: 'R', email: 'nobody@example.com' }),
    );
    // Both wait out the same floor. A miss that returned immediately would be a yes/no oracle.
    expect(missMs).toBeGreaterThanOrEqual(200);
    expect(Math.abs(hitMs - missMs)).toBeLessThan(150);
  });

  it('matches the reference and the address case-insensitively', async () => {
    // A reference is read off a screen or down a phone; neither is a password.
    const { service, bookingFindFirst } = setup({ booking: found });
    await service.requestAccessLink({
      reference: '  etg-ind-2026-000123 ',
      email: ' BOBBY.TABLES@EXAMPLE.COM ',
    });
    expect(bookingFindFirst.mock.calls[0][0].where).toEqual({
      reference: { equals: 'etg-ind-2026-000123', mode: 'insensitive' },
      buyerEmail: { equals: 'BOBBY.TABLES@EXAMPLE.COM', mode: 'insensitive' },
      userId: null,
    });
  });

  it('never returns the link, and never puts it in the subject line', async () => {
    const { service, send } = setup({ booking: found });
    const response = await service.requestAccessLink({
      reference: 'ETG-IND-2026-000123',
      email: 'bobby.tables@example.com',
    });
    expect(response).toEqual({ sent: true });
    const payload = send.mock.calls[0][0];
    expect(payload.type).toBe('GUEST_BOOKING_ACCESS');
    expect(payload.toEmail).toBe('bobby.tables@example.com');
    expect(String(payload.payload.link)).toMatch(
      /^https:\/\/tickets\.example\.com\/booking\/access\/[\w-]{20,}$/,
    );
    // The credential is the whole of the payload's link field and nothing else travels with it.
    expect(Object.keys(payload.payload)).toEqual(['link']);
  });

  it('mints the token and enqueues the email in one transaction', async () => {
    // Split, a crash either mails a link that was rolled back or supersedes a working one silently.
    const { service, accessCreate, send, ...rest } = setup({ booking: found });
    await service.requestAccessLink({ reference: 'R', email: 'bobby.tables@example.com' });
    expect(rest.accessDeleteMany).toHaveBeenCalledWith({ where: { bookingId: 'bk-1' } });
    expect(accessCreate).toHaveBeenCalledTimes(1);
    // The enqueue was handed the same transaction client the token was written with.
    expect(send.mock.calls[0][1]).toBeDefined();
  });

  it('stores only a hash of what it emailed', async () => {
    const { service, accessCreate, send } = setup({ booking: found });
    await service.requestAccessLink({ reference: 'R', email: 'bobby.tables@example.com' });
    const link = String(send.mock.calls[0][0].payload.link);
    const raw = link.slice(link.lastIndexOf('/') + 1);
    const stored = accessCreate.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(hashGuestAccessToken(raw));
    expect(stored.tokenHash).not.toBe(raw);
    expect(JSON.stringify(stored)).not.toContain(raw);
  });
});

describe('an emailed link stops working when it should', () => {
  it('404s for a token nothing was ever issued for', async () => {
    const { service } = setup({ access: null });
    await expect(service.viewByAccessToken('made-up')).rejects.toMatchObject({ status: 404 });
  });

  it('404s for an expired token, and says nothing else', async () => {
    const { service } = setup({
      access: live('expired', new Date(Date.now() - 1000)),
      booking: CONFIRMED_BOOKING,
    });
    const err = await service.viewByAccessToken('expired').catch((e) => e);
    expect(err.status).toBe(404);
    // Not 401: a 401 would confirm the token was real and the booking behind it exists.
    expect(err.message).toBe('Booking not found.');
  });

  it('404s for a superseded token, because re-issuing deleted its row', async () => {
    /*
      Two live links for one booking means an older one — already forwarded, or in a mailbox
      somebody else now reads — still opens it after the owner asked for a fresh one. Proven
      through the real issuing path rather than by asserting a delete call.
    */
    const { service, send, accessDeleteMany } = setup({
      booking: {
        id: 'bk-1',
        buyerEmail: 'bobby.tables@example.com',
        createdAt: CONFIRMED_BOOKING.createdAt,
        organizationId: 'org-1',
      },
    });
    await service.requestAccessLink({ reference: 'R', email: 'bobby.tables@example.com' });
    const first = String(send.mock.calls[0][0].payload.link);
    await service.requestAccessLink({ reference: 'R', email: 'bobby.tables@example.com' });
    const second = String(send.mock.calls[1][0].payload.link);

    expect(first).not.toBe(second);
    // Every earlier row for the booking went, not just the one matching some filter.
    expect(accessDeleteMany).toHaveBeenLastCalledWith({ where: { bookingId: 'bk-1' } });

    // With its row gone, the first token resolves to nothing.
    const reader = setup({ access: null });
    await expect(
      reader.service.viewByAccessToken(first.slice(first.lastIndexOf('/') + 1)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('counts the open only once the booking is known to be readable', async () => {
    const row = live('live', new Date(Date.now() + 60_000));
    const ok = setup({ access: row, booking: CONFIRMED_BOOKING });
    await ok.service.viewByAccessToken('live');
    expect(ok.accessUpdate.mock.calls[0][0].data.openCount).toEqual({ increment: 1 });
    expect(ok.accessUpdate.mock.calls[0][0].data.lastOpenedAt).toBeInstanceOf(Date);

    // A token whose booking cannot be returned leaves no record on a row it never reached.
    const refused = setup({ access: row, booking: null });
    await refused.service.viewByAccessToken('live').catch(() => undefined);
    expect(refused.accessUpdate).not.toHaveBeenCalled();
  });

  it('404s when the stored hash is not the token presented', async () => {
    // Belt and braces: the row is found BY the hash, so this can only fail if the way the row
    // is located ever changes. The refusal is asserted so that change cannot pass silently.
    const { service } = setup({
      access: live('some-other-token', new Date(Date.now() + 60_000)),
      booking: CONFIRMED_BOOKING,
    });
    await expect(service.viewByAccessToken('live')).rejects.toMatchObject({ status: 404 });
  });

  it('tells the reader when the link expires', async () => {
    const expiresAt = new Date('2026-09-25T10:00:00.000Z');
    const { service } = setup({
      access: live('live', expiresAt),
      booking: CONFIRMED_BOOKING,
    });
    const view = await service.viewByAccessToken('live');
    expect(view.accessExpiresAt).toBe(expiresAt.toISOString());
  });

  it('sends no expiry for a booking opened with the checkout session', async () => {
    // There is no link to expire; a date here would be invented.
    const { service } = setup({ booking: CONFIRMED_BOOKING });
    const view = await service.viewBySession('bk-1', session());
    expect(view.accessExpiresAt).toBeNull();
  });
});

describe('how long a guest link lives', () => {
  it('outlives the show it admits somebody to, however far off that is', () => {
    /*
      The case this exists for: tickets bought three weeks ahead. The guest's only other handle
      is a token in one browser's memory, so a link that expired on a fixed week would leave a
      paid ticket unreachable on the night. A day past the start covers a late arrival and a
      show that runs past midnight.
    */
    const showStart = new Date(NOW.getTime() + 21 * 24 * 60 * 60 * 1000);
    expect(guestAccessExpiry(NOW, showStart).getTime()).toBe(
      showStart.getTime() + 24 * 60 * 60 * 1000,
    );
  });

  it('is a week when the show is sooner than that, or unknown', () => {
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(guestAccessExpiry(NOW, tomorrow).getTime()).toBe(
      NOW.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    expect(guestAccessExpiry(NOW, null).getTime()).toBe(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  });
});

describe('the QR is only ever handed over when there is something to admit', () => {
  it('carries no code before the booking is confirmed', async () => {
    const { service, ticketsForGuestBooking } = setup({
      booking: { ...CONFIRMED_BOOKING, status: 'PENDING_PAYMENT', reference: null },
    });
    const view = await service.viewBySession('bk-1', session());
    expect(view.tickets.every((t) => t.qrToken === null && t.qrDataUrl === null)).toBe(true);
    // Not stripped afterwards: no credential was minted at all, so none can leak through a
    // later refactor of the projection.
    expect(ticketsForGuestBooking).not.toHaveBeenCalled();
  });

  it('carries no code for a partially refunded booking either', async () => {
    const { service, ticketsForGuestBooking } = setup({
      booking: { ...CONFIRMED_BOOKING, status: 'PARTIALLY_REFUNDED' },
    });
    const view = await service.viewBySession('bk-1', session());
    expect(view.tickets.map((t) => t.qrToken)).toEqual([null, null]);
    expect(ticketsForGuestBooking).not.toHaveBeenCalled();
  });

  it('takes the code from TicketsService rather than signing one here', async () => {
    const { service, ticketsForGuestBooking } = setup({
      booking: CONFIRMED_BOOKING,
      presented: [
        { id: 'tk-1', qrToken: 'signed-1', qrDataUrl: 'data:image/png;base64,AAA' },
        // A ticket TicketsService withheld the credential for — a transfer. Nothing here
        // second-guesses that: absent stays absent.
        { id: 'tk-2', qrToken: null, qrDataUrl: null },
      ],
    });
    const view = await service.viewBySession('bk-1', session());
    expect(ticketsForGuestBooking).toHaveBeenCalledWith('bk-1');
    expect(view.tickets.map((t) => [t.id, t.qrToken])).toEqual([
      ['tk-1', 'signed-1'],
      ['tk-2', null],
    ]);
  });
});

describe('the money is read, never recalculated', () => {
  it('reports the four totals the booking stored, in minor units', async () => {
    const { service } = setup({ booking: CONFIRMED_BOOKING });
    const view = await service.viewBySession('bk-1', session());
    expect(view.totals).toEqual({
      subtotalMinor: 50000,
      feesMinor: 3000,
      taxMinor: 1500,
      totalMinor: 54500,
    });
    // Integers, all of them. A float here is a rounding bug waiting for a currency with no
    // minor unit.
    for (const value of Object.values(view.totals)) expect(Number.isInteger(value)).toBe(true);
  });

  it('never exposes the organizer or platform fee columns', async () => {
    const { service } = setup({
      booking: { ...CONFIRMED_BOOKING, organizerFeeMinor: 999, bookingFeeMinor: 777 },
    });
    const view = await service.viewBySession('bk-1', session());
    expect(JSON.stringify(view)).not.toContain('999');
    expect(JSON.stringify(view)).not.toContain('777');
  });
});

describe('the shape a guest is handed', () => {
  it('is exactly the GuestBookingView, with no booking row leaking through it', async () => {
    const { service } = setup({
      booking: CONFIRMED_BOOKING,
      presented: [{ id: 'tk-1', qrToken: 'signed-1', qrDataUrl: 'data:image/png;base64,AAA' }],
    });
    const view = await service.viewBySession('bk-1', session());

    expect(Object.keys(view).sort()).toEqual(
      [
        'accessExpiresAt',
        'buyer',
        'currency',
        'event',
        'holdExpiresAt',
        'id',
        'items',
        'reference',
        'status',
        'tickets',
        'totals',
      ].sort(),
    );
    // Nothing a forwarded link has any business carrying.
    const serialised = JSON.stringify(view);
    for (const forbidden of ['userId', 'buyerEmail', 'idempotencyKey', 'payment', 'couponId']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('names the show in the venue’s clock, not the reader’s', async () => {
    const { service } = setup({ booking: CONFIRMED_BOOKING });
    const view = await service.viewBySession('bk-1', session());
    expect(view.event).toEqual({
      title: 'Kantara',
      slug: 'kantara',
      startsAt: '2026-09-20T13:30:00.000Z',
      timeZone: 'Asia/Kolkata',
      venueName: 'PVR Forum Mall',
      cinemaName: 'PVR Vijayawada',
      screenName: 'Screen 3',
    });
  });

  it('falls back to the venue’s zone for an event that is not in a cinema', async () => {
    const { service } = setup({
      booking: {
        ...CONFIRMED_BOOKING,
        event: {
          ...CONFIRMED_BOOKING.event,
          venue: { name: 'Jawaharlal Stadium', timezone: 'UTC' },
        },
        eventSession: { startsAt: CONFIRMED_BOOKING.eventSession.startsAt, screen: null },
      },
    });
    const view = await service.viewBySession('bk-1', session());
    expect(view.event.timeZone).toBe('UTC');
    expect(view.event.cinemaName).toBeNull();
    expect(view.event.screenName).toBeNull();
  });

  it('lists the order lines and the seats separately', async () => {
    const { service } = setup({ booking: CONFIRMED_BOOKING });
    const view = await service.viewBySession('bk-1', session());
    expect(view.items).toEqual([
      // Two seats at one price are ONE line, so the line names no single seat. The seats are
      // on `tickets`, one entry each, which is where a client should read them.
      { label: 'Gold', quantity: 2, unitPriceMinor: 25000, seatLabel: null },
    ]);
    expect(view.tickets.map((t) => [t.seatLabel, t.ticketTypeName, t.checkedInAt])).toEqual([
      ['H1', 'Gold', null],
      ['H2', 'Gold', '2026-09-20T13:05:00.000Z'],
    ]);
  });

  it('is this, exactly — the whole contract in one object', async () => {
    /*
      Written out in full rather than field by field. Every other test here asserts one
      property; this one is the shape itself, so ADDING a field to the projection fails a test
      and somebody has to decide whether a forwardable link should carry it.
    */
    const { service } = setup({
      booking: CONFIRMED_BOOKING,
      access: live('live-token', new Date('2026-09-25T09:50:00.000Z')),
      presented: [
        { id: 'tk-1', qrToken: 'qr-token-1', qrDataUrl: 'data:image/png;base64,AAA' },
        { id: 'tk-2', qrToken: 'qr-token-2', qrDataUrl: 'data:image/png;base64,BBB' },
      ],
    });
    const view = await service.viewByAccessToken('live-token');
    expect(view).toEqual({
      id: 'bk-1',
      reference: 'ETG-IND-2026-000123',
      status: 'CONFIRMED',
      currency: 'INR',
      holdExpiresAt: '2026-09-18T10:10:00.000Z',
      event: {
        title: 'Kantara',
        slug: 'kantara',
        startsAt: '2026-09-20T13:30:00.000Z',
        timeZone: 'Asia/Kolkata',
        venueName: 'PVR Forum Mall',
        cinemaName: 'PVR Vijayawada',
        screenName: 'Screen 3',
      },
      buyer: { name: 'Bobby Tables', emailMasked: 'bo***@example.com' },
      totals: { subtotalMinor: 50000, feesMinor: 3000, taxMinor: 1500, totalMinor: 54500 },
      items: [{ label: 'Gold', quantity: 2, unitPriceMinor: 25000, seatLabel: null }],
      tickets: [
        {
          id: 'tk-1',
          seatLabel: 'H1',
          ticketTypeName: 'Gold',
          qrToken: 'qr-token-1',
          qrDataUrl: 'data:image/png;base64,AAA',
          checkedInAt: null,
        },
        {
          id: 'tk-2',
          seatLabel: 'H2',
          ticketTypeName: 'Gold',
          qrToken: 'qr-token-2',
          qrDataUrl: 'data:image/png;base64,BBB',
          checkedInAt: '2026-09-20T13:05:00.000Z',
        },
      ],
      accessExpiresAt: '2026-09-25T09:50:00.000Z',
    });
  });

  it('names the seat on a line that is one seat', async () => {
    const { service } = setup({
      booking: {
        ...CONFIRMED_BOOKING,
        items: [{ ...CONFIRMED_BOOKING.items[0], quantity: 1 }],
        tickets: [CONFIRMED_BOOKING.tickets[0]],
      },
    });
    const view = await service.viewBySession('bk-1', session());
    expect(view.items[0].seatLabel).toBe('H1');
  });
});
