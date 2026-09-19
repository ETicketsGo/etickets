import { GuestBookingService } from './guest-booking.service';
import { guestProvenEmail } from './bookings.controller';
import { guestEmailMatches, hashGuestAccessToken } from './guest-access';
import { AnonymousSessionService } from './orchestration/booking-owner';
import { GuestSessionVerifier } from './guest-session';
import { renderReceiptHtml } from '../receipts/receipt-html';
import type { ReceiptDocument } from '../receipts/receipt-document';
import { ReceiptsController } from '../receipts/receipts.controller';
import { RefundsService } from '../refunds/refunds.service';
import { MetricsService } from '../metrics/metrics.service';
import { BookingStatus, TicketStatus } from '@eticketsgo/shared-types';
import type { RequestUser } from '../common/decorators';

/**
 * What a guest can now do, and what a forwarded link still cannot.
 *
 * ── THE ONE RULE THIS SUITE EXISTS FOR ─────────────────────────────────────────────
 * The emailed link is forwardable by design: it shows somebody where to sit, and it masks the
 * buyer's address precisely so it does not show who bought the seat. Three new things are not
 * like seeing a seat — an invoice names the buyer and an amount, a refund moves money off their
 * card, and a claim gives the booking to an account — so each asks for one more proof.
 *
 * Every test below is about a refusal or about the two doors landing in the same place. The happy
 * paths are a query and a projection; it is the refusals that carry the risk, and all of them are
 * silent. A receipt route that compared addresses with `===`, a refund route that skipped the
 * comparison on one branch, a claim that trusted a client-minted session token — none of those
 * throws, logs, or looks wrong in a response somebody is reading casually.
 */

const BUYER_EMAIL = 'bobby.tables@example.com';
const LIVE_TOKEN = 'a-live-guest-access-token';

/** A stored access row for one raw token, hashed for real so the constant-time check is real. */
const access = (rawToken: string, opts: { bookingId?: string; expiresAt?: Date } = {}) => ({
  id: 'ga-1',
  bookingId: opts.bookingId ?? 'bk-1',
  expiresAt: opts.expiresAt ?? new Date(Date.now() + 60_000),
  tokenHash: hashGuestAccessToken(rawToken),
});

/** The frozen document a receipt row carries. Built, not mocked: the real renderer reads it. */
const DOCUMENT: ReceiptDocument = {
  version: 1,
  kind: 'TAX_INVOICE',
  number: 'INV-2026-000012',
  issuedAt: '2026-09-18T10:00:00.000Z',
  currency: 'INR',
  seller: {
    name: 'PVR Cinemas',
    legalName: 'PVR Limited',
    taxRegistrationKind: 'GSTIN',
    taxRegistrationNumber: '37ABCDE1234F1Z5',
    address: {
      line1: '1 Forum Mall',
      line2: null,
      city: 'Vijayawada',
      region: 'Andhra Pradesh',
      postalCode: '520010',
      country: 'IN',
    },
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  },
  buyer: { name: 'Bobby Tables', email: BUYER_EMAIL },
  order: {
    bookingId: 'bk-1',
    reference: 'ETG-IND-2026-000123',
    eventTitle: 'Kantara',
    sessionStartsAt: '2026-09-20T13:30:00.000Z',
    venue: 'PVR Vijayawada',
  },
  lines: [{ description: 'Gold', quantity: 2, unitPriceMinor: 25000, lineTotalMinor: 50000 }],
  taxLines: [],
  totals: {
    subtotalMinor: 50000,
    discountMinor: 0,
    feeMinor: 3000,
    taxMinor: 1500,
    totalMinor: 54500,
  },
  notes: [],
};

const SALE_ROW = {
  id: 'rc-1',
  number: 'INV-2026-000012',
  kind: 'TAX_INVOICE',
  issuedAt: new Date('2026-09-18T10:00:00.000Z'),
  currency: 'INR',
  totalMinor: 54500,
  taxMinor: 1500,
};
const CREDIT_NOTE_ROW = {
  id: 'rc-2',
  number: 'CRN-2026-000003',
  kind: 'CREDIT_NOTE',
  issuedAt: new Date('2026-09-19T10:00:00.000Z'),
  currency: 'INR',
  totalMinor: -27250,
  taxMinor: -750,
};

interface Stubs {
  /** The guest booking as `findFirst` (which filters `userId: null`) would return it. */
  booking?: Record<string, unknown> | null;
  /** The row `findUnique` returns on the claim path, where an owner may already exist. */
  owned?: Record<string, unknown> | null;
  accessRow?: Record<string, unknown> | null;
  receipts?: (typeof SALE_ROW)[];
  /** How many rows the conditional claim write actually changed. */
  claimCount?: number;
  /** Who owns the booking when the claim re-reads it after losing a race. */
  afterRace?: string | null;
  workflow?: { ownerType: string | null; ownerId: string | null } | null;
  refund?: unknown;
  /**
   * The session the booking was created under, as the column holds it: the SHA-256 of a raw
   * token. `undefined` means a booking from before that column existed — a null hash — which is
   * the legacy case, so it is the default here on purpose: the tests that care state a hash.
   */
  sessionHash?: string | null;
  /** Whether the orchestrator is in ACTIVE mode. Every real environment is not. */
  active?: boolean;
}

/**
 * A guest booking as the read route needs it.
 *
 * Fuller than the money routes require — those select three columns — because `viewBySession`
 * projects a whole view, and the session check has to be tested through the route that does it
 * rather than through a stub shaped only for the routes that do not.
 */
const viewable = (guestSessionHash: string | null) => ({
  id: 'bk-1',
  userId: null,
  guestSessionHash,
  organizationId: 'org-1',
  reference: 'ETG-IND-2026-000123',
  status: BookingStatus.CONFIRMED,
  currency: 'INR',
  holdExpiresAt: null,
  createdAt: new Date('2026-09-18T09:50:00.000Z'),
  buyerName: 'Bobby Tables',
  buyerEmail: BUYER_EMAIL,
  subtotalMinor: 50000,
  customerFeeMinor: 3000,
  taxMinor: 1500,
  totalMinor: 54500,
  items: [],
  event: { title: 'Kantara', slug: 'kantara', venue: { name: 'PVR', timezone: 'Asia/Kolkata' } },
  eventSession: { startsAt: new Date('2026-09-20T13:30:00.000Z'), screen: null },
  tickets: [],
});

function setup(stubs: Stubs = {}) {
  const sessionHash = stubs.sessionHash ?? null;
  const guestBooking = stubs.booking === undefined ? viewable(sessionHash) : stubs.booking;

  const bookingFindFirst = jest.fn().mockResolvedValue(guestBooking);
  const bookingFindUnique = jest
    .fn()
    .mockResolvedValue(
      stubs.owned === undefined
        ? { id: 'bk-1', userId: null, organizationId: 'org-1', guestSessionHash: sessionHash }
        : stubs.owned,
    );
  const bookingUpdateMany = jest.fn().mockResolvedValue({ count: stubs.claimCount ?? 1 });
  const accessFindUnique = jest.fn().mockResolvedValue(stubs.accessRow ?? null);
  const accessDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const accessUpdate = jest.fn().mockResolvedValue({});

  const tx = {
    booking: { updateMany: bookingUpdateMany },
    guestBookingAccess: { deleteMany: accessDeleteMany },
  };
  const prisma = {
    booking: { findFirst: bookingFindFirst, findUnique: bookingFindUnique },
    guestBookingAccess: { findUnique: accessFindUnique, update: accessUpdate },
    $transaction: jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(tx)),
  };
  if (stubs.afterRace !== undefined) {
    // First read is the pre-flight; the second is the post-race re-read.
    bookingFindUnique
      .mockResolvedValueOnce({
        id: 'bk-1',
        userId: null,
        organizationId: 'org-1',
        guestSessionHash: sessionHash,
      })
      .mockResolvedValueOnce({ userId: stubs.afterRace });
  }

  const listForBooking = jest.fn().mockResolvedValue(stubs.receipts ?? [SALE_ROW]);
  const document = jest.fn().mockResolvedValue({
    receipt: { organizationId: 'org-1', bookingId: 'bk-1', number: DOCUMENT.number },
    document: DOCUMENT,
  });
  const requestAsGuest = jest.fn().mockResolvedValue(stubs.refund ?? { id: 'rf-1' });
  const record = jest.fn().mockResolvedValue(undefined);

  const anon = new AnonymousSessionService();
  const workflows = { getByBookingId: jest.fn().mockResolvedValue(stubs.workflow ?? null) };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'BOOKING_ORCHESTRATOR_ENABLED') return stubs.active === true;
      if (key === 'BOOKING_ORCHESTRATOR_MODE') return stubs.active ? 'active' : 'shadow';
      return fallback;
    }),
  };

  const service = new GuestBookingService(
    prisma as never,
    { ticketsForGuestBooking: jest.fn().mockResolvedValue([]) } as never,
    { send: jest.fn() } as never,
    config as never,
    anon,
    /*
      The REAL verifier over the same stubs, not a mock of it: the session binding is the rule these
      suites are about, and a stubbed verifier would assert only that a method was called.
    */
    new GuestSessionVerifier(prisma as never, config as never, workflows as never, anon),
    { listForBooking, document } as never,
    { requestAsGuest } as never,
    { record } as never,
  );
  return {
    service,
    anon,
    prisma,
    bookingFindFirst,
    bookingFindUnique,
    bookingUpdateMany,
    accessFindUnique,
    accessDeleteMany,
    listForBooking,
    document,
    requestAsGuest,
    record,
    workflows,
  };
}

const ACCOUNT: RequestUser = {
  id: 'u1',
  email: BUYER_EMAIL,
  fullName: 'Bobby Tables',
  roles: [] as never,
};

// ───────────────────────────────────────────────────────────────────────────────
// The address comparison itself
// ───────────────────────────────────────────────────────────────────────────────

describe('the address that paid is matched forgivingly and compared safely', () => {
  it('ignores case and surrounding whitespace, because it is typed by a person', () => {
    // On a phone that capitalises the first letter, from a clipboard that brings a space.
    expect(guestEmailMatches('  BOBBY.TABLES@EXAMPLE.COM ', BUYER_EMAIL)).toBe(true);
    expect(guestEmailMatches('Bobby.Tables@Example.com', BUYER_EMAIL)).toBe(true);
    expect(guestEmailMatches(BUYER_EMAIL, '  BOBBY.TABLES@EXAMPLE.COM ')).toBe(true);
  });

  it('refuses an address that is merely close', () => {
    expect(guestEmailMatches('bobby.table@example.com', BUYER_EMAIL)).toBe(false);
    expect(guestEmailMatches('bobby.tables@example.co', BUYER_EMAIL)).toBe(false);
    // The two characters the masked view reveals are not enough, which is the point of masking.
    expect(guestEmailMatches('bo@example.com', BUYER_EMAIL)).toBe(false);
  });

  it('is still a valid address to the route after the spaces come off', () => {
    /*
      Nearly shipped the other way round. `z.string().email()` REFUSES a trailing space, so an
      address pasted from a phone's clipboard would have been rejected as malformed at the route
      boundary — a 400 saying "not an email" — long before the forgiving comparison below ever
      saw it. The trim has to happen first, and the case has to survive it: lower-casing belongs
      in the comparison, which is the only place allowed to decide what counts as equal.
    */
    expect(guestProvenEmail.parse('  BOBBY.TABLES@EXAMPLE.COM ')).toBe('BOBBY.TABLES@EXAMPLE.COM');
    expect(guestProvenEmail.parse(` ${BUYER_EMAIL}\t`)).toBe(BUYER_EMAIL);
    expect(() => guestProvenEmail.parse('not-an-address')).toThrow();
  });

  it('matches nothing when either side is empty', () => {
    // A booking with no recorded address must not be openable by submitting an empty field.
    expect(guestEmailMatches('', BUYER_EMAIL)).toBe(false);
    expect(guestEmailMatches(BUYER_EMAIL, '')).toBe(false);
    expect(guestEmailMatches('', '')).toBe(false);
    expect(guestEmailMatches(undefined, null)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// The security rule, on both money routes
// ───────────────────────────────────────────────────────────────────────────────

describe('a forwarded link cannot get the invoice without the address', () => {
  it('refuses, and never reaches the documents', async () => {
    const { service, listForBooking, document } = setup({ accessRow: access(LIVE_TOKEN) });
    await expect(
      service.receiptsByAccessToken(LIVE_TOKEN, { email: 'someone.else@example.com' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(listForBooking).not.toHaveBeenCalled();
    expect(document).not.toHaveBeenCalled();
  });

  it('refuses an empty address, which is what an unfilled form sends', async () => {
    const { service, listForBooking } = setup({ accessRow: access(LIVE_TOKEN) });
    await expect(service.receiptsByAccessToken(LIVE_TOKEN, { email: '   ' })).rejects.toMatchObject(
      { status: 403 },
    );
    expect(listForBooking).not.toHaveBeenCalled();
  });

  it('lets the real buyer through, however they typed it', async () => {
    const { service } = setup({ accessRow: access(LIVE_TOKEN) });
    await expect(
      service.receiptsByAccessToken(LIVE_TOKEN, { email: '  BOBBY.TABLES@EXAMPLE.COM ' }),
    ).resolves.toMatchObject({ documents: [expect.objectContaining({ id: 'rc-1' })] });
  });
});

describe('a forwarded link cannot request a refund without the address', () => {
  it('refuses, and never reaches the refund service', async () => {
    const { service, requestAsGuest } = setup({ accessRow: access(LIVE_TOKEN) });
    await expect(
      service.requestRefundByAccessToken(LIVE_TOKEN, { email: 'someone.else@example.com' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(requestAsGuest).not.toHaveBeenCalled();
  });

  it('lets the real buyer through, however they typed it', async () => {
    const { service, requestAsGuest } = setup({ accessRow: access(LIVE_TOKEN) });
    await expect(
      service.requestRefundByAccessToken(LIVE_TOKEN, { email: ' Bobby.Tables@Example.com ' }),
    ).resolves.toEqual({ id: 'rf-1' });
    expect(requestAsGuest).toHaveBeenCalledWith({
      bookingId: 'bk-1',
      // A reason is required on the stored refund; a guest who typed none gets a true sentence
      // rather than words attributed to them that they never said.
      reason: 'Requested by the buyer, who has no account.',
    });
  });

  it("passes the customer's own reason when they gave one", async () => {
    const { service, requestAsGuest } = setup({ accessRow: access(LIVE_TOKEN) });
    await service.requestRefundByAccessToken(LIVE_TOKEN, {
      email: BUYER_EMAIL,
      reason: '  the show clashes with a wedding  ',
    });
    expect(requestAsGuest).toHaveBeenCalledWith({
      bookingId: 'bk-1',
      reason: 'the show clashes with a wedding',
    });
  });
});

describe('a dead link is refused before the address is even considered', () => {
  it.each([
    ['a token nothing was issued for', null],
    ['an expired token', access(LIVE_TOKEN, { expiresAt: new Date(Date.now() - 1000) })],
  ])('404s for %s, on both money routes', async (_label, accessRow) => {
    const receipts = setup({ accessRow });
    await expect(
      receipts.service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL }),
    ).rejects.toMatchObject({ status: 404, message: 'Booking not found.' });
    // Not a 403 and not a different message: a live-but-wrong-address answer would confirm to
    // somebody spraying tokens that this one is real.
    expect(receipts.bookingFindFirst).not.toHaveBeenCalled();

    const refunds = setup({ accessRow });
    await expect(
      refunds.service.requestRefundByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL }),
    ).rejects.toMatchObject({ status: 404 });
    expect(refunds.requestAsGuest).not.toHaveBeenCalled();
  });

  it('404s when the stored hash is not the token presented', async () => {
    const { service } = setup({ accessRow: access('some-other-token') });
    await expect(
      service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('an account booking is never reachable through these routes', () => {
  it('asks the database for a booking with no owner, rather than filtering afterwards', async () => {
    const { service, bookingFindFirst } = setup({ accessRow: access(LIVE_TOKEN) });
    await service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL });
    expect(bookingFindFirst.mock.calls[0][0].where).toEqual({ id: 'bk-1', userId: null });
  });

  it('404s once the booking has been claimed, even on a link that is still live', async () => {
    /*
      The access row OUTLIVES the booking becoming an account booking — nothing deletes it
      retroactively — so the guarantee has to come from the query, and it does: a booking with an
      owner cannot be found by a statement that requires `userId: null`.
    */
    const { service, requestAsGuest } = setup({ accessRow: access(LIVE_TOKEN), booking: null });
    await expect(
      service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.requestRefundByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL }),
    ).rejects.toMatchObject({ status: 404 });
    expect(requestAsGuest).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// The documents themselves
// ───────────────────────────────────────────────────────────────────────────────

describe('the documents a guest is handed are the ones the platform issued', () => {
  it('lists them and renders the primary one with the shared renderer', async () => {
    const { service } = setup({ accessRow: access(LIVE_TOKEN) });
    const result = await service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL });

    expect(result.documents).toEqual([
      {
        id: 'rc-1',
        kind: 'TAX_INVOICE',
        number: 'INV-2026-000012',
        issuedAt: '2026-09-18T10:00:00.000Z',
        totalMinor: 54500,
        currency: 'INR',
      },
    ]);
    // Byte-for-byte what the account route serves. A second renderer here would be a second
    // thing that can disagree with the organizer's books about an amount.
    expect(result.html).toBe(renderReceiptHtml(DOCUMENT, 'en'));
  });

  it('renders the sale document, never the credit note, as the primary', async () => {
    /*
      A partly refunded booking has both. Rendering the newest would show the buyer a negative
      total naming none of the tickets they still hold, as "your receipt".
    */
    const { service, document } = setup({
      accessRow: access(LIVE_TOKEN),
      receipts: [SALE_ROW, CREDIT_NOTE_ROW],
    });
    const result = await service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL });
    expect(document).toHaveBeenCalledWith('rc-1');
    expect(result.documents.map((d) => d.kind)).toEqual(['TAX_INVOICE', 'CREDIT_NOTE']);
  });

  it('answers empty rather than erroring when nothing has been issued yet', async () => {
    // A free booking has no sale to document and an unpaid one has nothing to show. Neither is a
    // fault the buyer can act on, and a 404 would read as "we have lost your invoice".
    const { service, document } = setup({ accessRow: access(LIVE_TOKEN), receipts: [] });
    await expect(
      service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL }),
    ).resolves.toEqual({ documents: [], html: '' });
    expect(document).not.toHaveBeenCalled();
  });

  it('renders in the language the page asked for, then the browser’s', async () => {
    const asked = setup({ accessRow: access(LIVE_TOKEN) });
    const byLocale = await asked.service.receiptsByAccessToken(LIVE_TOKEN, {
      email: BUYER_EMAIL,
      locale: 'fr-CA',
      acceptLanguage: 'en-GB',
    });
    expect(byLocale.html).toBe(renderReceiptHtml(DOCUMENT, 'fr-CA'));

    const header = setup({ accessRow: access(LIVE_TOKEN) });
    const byHeader = await header.service.receiptsByAccessToken(LIVE_TOKEN, {
      email: BUYER_EMAIL,
      acceptLanguage: 'fr-CA,fr;q=0.9',
    });
    expect(byHeader.html).toBe(renderReceiptHtml(DOCUMENT, 'fr-CA'));
  });

  it('audits the view without recording the credential or the address', async () => {
    const { service, record } = setup({ accessRow: access(LIVE_TOKEN) });
    await service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL });
    const entry = record.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorUserId: null,
      action: 'GUEST_RECEIPT_VIEWED',
      entityType: 'Receipt',
      entityId: 'rc-1',
    });
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain(LIVE_TOKEN);
    expect(serialised).not.toContain(BUYER_EMAIL);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// The claim
// ───────────────────────────────────────────────────────────────────────────────

describe('attaching a guest booking to an account', () => {
  const sessionFor = (token: string) => ({
    ownerType: 'ANONYMOUS_SESSION',
    ownerId: new AnonymousSessionService().hash(token),
  });

  it('the session that created a booking can claim it', async () => {
    /*
      The end-to-end failure this exists for. The proof used to be the workflow's owner, and that
      row is written ONLY in active mode — which local, QA, UAT and production do not run. So the
      browser that had just bought the booking was told to "open it from the link in your
      confirmation email", and "save this booking to my account" could not succeed anywhere.

      Shadow mode here, deliberately: it is the mode every real environment is in.
    */
    const anon = new AnonymousSessionService();
    const token = anon.issueToken();
    const { service, bookingUpdateMany } = setup({ sessionHash: anon.hash(token) });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, anonymousToken: token }),
    ).resolves.toEqual({ bookingId: 'bk-1', claimed: true });
    expect(bookingUpdateMany).toHaveBeenCalledWith({
      // Conditional on still being unclaimed: the DATABASE decides, not a read a moment earlier.
      where: { id: 'bk-1', userId: null },
      data: { userId: 'u1' },
    });
  });

  it('a DIFFERENT well-formed session cannot claim it', async () => {
    // Possession of a booking id plus a self-minted token is not ownership of anything.
    const anon = new AnonymousSessionService();
    const { service, bookingUpdateMany } = setup({ sessionHash: anon.hash(anon.issueToken()) });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, anonymousToken: anon.issueToken() }),
    ).rejects.toMatchObject({ status: 403 });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });

  it('a booking WITH a hash refuses a non-matching token even in shadow mode', async () => {
    /*
      The regression that mattered: in shadow mode there was no binding to check, so ANY
      well-formed token was accepted on the read route and the booking id was effectively the
      whole credential. Asserted on the read AND the claim, in shadow, with a hash present.
    */
    const anon = new AnonymousSessionService();
    const bound = setup({ sessionHash: anon.hash(anon.issueToken()), active: false });
    await expect(bound.service.viewBySession('bk-1', anon.issueToken())).rejects.toMatchObject({
      status: 403,
      message: 'This booking was not started in this browser.',
    });
    await expect(
      bound.service.claim({ bookingId: 'bk-1', user: ACCOUNT, anonymousToken: anon.issueToken() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('a legacy booking with a null hash still reads, and cannot be claimed by a session', async () => {
    /*
      ── WHY THE TWO ROUTES ANSWER DIFFERENTLY FOR THE SAME BOOKING ──────────────────
      A booking that predates the column records no session and cannot acquire one: the raw token
      lives only in a browser. Reading it on a well-formed token is what every environment already
      did, and refusing that would lock somebody out of tickets they paid for.

      Claiming is not the same act. It is permanent and it takes the tickets away from whoever
      bought them, so "a booking id plus 256 bits I generated myself" must not be enough — that is
      not a lock-out risk, it is a theft risk. The refusal names the way forward, because for this
      caller one really exists: the link in their confirmation email, which IS accepted here.
    */
    const anon = new AnonymousSessionService();
    const token = anon.issueToken();
    const { service, bookingUpdateMany } = setup({ sessionHash: null });

    await expect(service.viewBySession('bk-1', token)).resolves.toMatchObject({ id: 'bk-1' });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, anonymousToken: token }),
    ).rejects.toMatchObject({
      status: 403,
      message:
        'This booking cannot be added to your account. Open it from the link in your confirmation email and try again.',
    });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });

  it('a legacy booking is still claimable with the emailed link, which is a proof it has', async () => {
    // The other half of the refusal above: strictness on the session must not leave the buyer of an
    // unbound booking with no way to adopt it at all.
    const { service, bookingUpdateMany } = setup({
      sessionHash: null,
      accessRow: access(LIVE_TOKEN),
    });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN }),
    ).resolves.toEqual({ bookingId: 'bk-1', claimed: true });
    expect(bookingUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('the session hash is never returned, and never written to the audit trail', async () => {
    const anon = new AnonymousSessionService();
    const token = anon.issueToken();
    const hash = anon.hash(token);
    const { service, record } = setup({ sessionHash: hash });

    const view = await service.viewBySession('bk-1', token);
    const claim = await service.claim({ bookingId: 'bk-1', user: ACCOUNT, anonymousToken: token });
    // Neither the digest nor the raw token reaches a response…
    for (const body of [JSON.stringify(view), JSON.stringify(claim)]) {
      expect(body).not.toContain(hash);
      expect(body).not.toContain(token);
      expect(body).not.toContain('guestSessionHash');
    }
    // …nor the audit entry, which names only which KIND of proof was presented.
    const audited = JSON.stringify(record.mock.calls[0][0]);
    expect(audited).not.toContain(hash);
    expect(audited).not.toContain(token);
    expect(record.mock.calls[0][0].metadata).toEqual({ proof: 'GUEST_SESSION' });
  });

  it('claims with the emailed access link, for a buyer signing in on another device', async () => {
    const { service, bookingUpdateMany } = setup({ accessRow: access(LIVE_TOKEN) });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN }),
    ).resolves.toEqual({ bookingId: 'bk-1', claimed: true });
    expect(bookingUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: re-claiming what the caller already owns writes nothing', async () => {
    /*
      And asks for no proof, deliberately. A client retrying a request whose answer it never saw
      must not be refused its own booking because the guest session has since been cleared —
      owning it IS the proof.
    */
    const { service, bookingUpdateMany, accessFindUnique, workflows } = setup({
      owned: { id: 'bk-1', userId: 'u1', organizationId: 'org-1' },
    });
    await expect(service.claim({ bookingId: 'bk-1', user: ACCOUNT })).resolves.toEqual({
      bookingId: 'bk-1',
      claimed: true,
    });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
    expect(accessFindUnique).not.toHaveBeenCalled();
    expect(workflows.getByBookingId).not.toHaveBeenCalled();
  });

  it('never displaces an existing owner', async () => {
    const { service, bookingUpdateMany } = setup({
      accessRow: access(LIVE_TOKEN),
      owned: { id: 'bk-1', userId: 'someone-else', organizationId: 'org-1' },
    });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This booking already belongs to an account.',
    });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });

  it('never displaces an existing owner even when the claim loses a race', async () => {
    // The conditional write changed nothing, so somebody claimed in between. The re-read decides.
    const { service } = setup({
      accessRow: access(LIVE_TOKEN),
      claimCount: 0,
      afterRace: 'someone-else',
    });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is still idempotent when the SAME account wins the race', async () => {
    const { service } = setup({ accessRow: access(LIVE_TOKEN), claimCount: 0, afterRace: 'u1' });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN }),
    ).resolves.toEqual({ bookingId: 'bk-1', claimed: true });
  });

  it('refuses when neither proof is presented', async () => {
    const { service, bookingUpdateMany } = setup();
    await expect(service.claim({ bookingId: 'bk-1', user: ACCOUNT })).rejects.toMatchObject({
      status: 403,
    });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses a session token that does not match the workflow, in active mode', async () => {
    /*
      A well-formed anonymous token is something the CALLER can mint — it is 256 random bits with
      a prefix — so matching nothing is not proof of anything. In active mode the workflow's owner
      is a second binding alongside the booking's own hash, and it still has to agree.
    */
    const mine = new AnonymousSessionService().issueToken();
    const { service } = setup({
      active: true,
      workflow: sessionFor('anon_somebody-elses-session'),
    });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, anonymousToken: mine }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a live link that belongs to a different booking', async () => {
    const { service } = setup({ accessRow: access(LIVE_TOKEN, { bookingId: 'bk-other' }) });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an expired link', async () => {
    const { service } = setup({
      accessRow: access(LIVE_TOKEN, { expiresAt: new Date(Date.now() - 1000) }),
    });
    await expect(
      service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('spends every emailed link for the booking, in the claiming transaction', async () => {
    /*
      A guest link is a forwardable bearer credential, and `requestAccessLink` already refuses to
      mint one for a booking with an owner. A link minted BEFORE the claim is the same credential.
    */
    const { service, accessDeleteMany } = setup({ accessRow: access(LIVE_TOKEN) });
    await service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN });
    expect(accessDeleteMany).toHaveBeenCalledWith({ where: { bookingId: 'bk-1' } });
  });

  it('audits which proof was used, and nothing that identifies it', async () => {
    const { service, record } = setup({ accessRow: access(LIVE_TOKEN) });
    await service.claim({ bookingId: 'bk-1', user: ACCOUNT, accessToken: LIVE_TOKEN });
    const entry = record.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorUserId: 'u1',
      organizationId: 'org-1',
      action: 'GUEST_BOOKING_CLAIMED',
      entityType: 'Booking',
      entityId: 'bk-1',
      metadata: { proof: 'ACCESS_LINK' },
    });
    expect(JSON.stringify(entry)).not.toContain(LIVE_TOKEN);
  });

  it('404s for a booking that does not exist, whatever is presented', async () => {
    const { service } = setup({ owned: null, accessRow: access(LIVE_TOKEN) });
    await expect(
      service.claim({ bookingId: 'bk-nope', user: ACCOUNT, accessToken: LIVE_TOKEN }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Life after the claim
// ───────────────────────────────────────────────────────────────────────────────

describe('after a claim the booking is an ordinary account booking', () => {
  /** The claimed booking as the account services see it: same row, now with an owner. */
  const claimed = {
    id: 'bk-1',
    userId: 'u1',
    organizationId: 'org-1',
    reference: 'ETG-IND-2026-000123',
    currency: 'INR',
    buyerEmail: BUYER_EMAIL,
    status: BookingStatus.CONFIRMED,
    paymentMethod: 'ONLINE',
    totalMinor: 100000,
    discountMinor: 0,
    seatBased: false,
    eventSessionId: 'sess-1',
    eventSession: { startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    event: { refundsEnabled: true, refundCutoffHours: 48 },
    tickets: [
      { id: 'tk1', status: TicketStatus.ACTIVE, ticketTypeId: 't1', seatId: null, invites: [] },
    ],
    taxLines: [],
  };

  it('is no longer readable through the guest routes', async () => {
    // Nothing had to be revoked for this to be true: every guest read requires `userId: null`.
    const { service } = setup({ booking: null, accessRow: access(LIVE_TOKEN) });
    await expect(service.viewByAccessToken(LIVE_TOKEN)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.receiptsByAccessToken(LIVE_TOKEN, { email: BUYER_EMAIL }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refunds through the ACCOUNT route, with no further change', async () => {
    const refundRow = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'rf-new',
        ...data,
      })),
    };
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0), refund: refundRow };
    const refunds = new RefundsService(
      {
        booking: { findUnique: jest.fn().mockResolvedValue(claimed) },
        refund: refundRow,
        bookingItem: {
          findMany: jest.fn().mockResolvedValue([{ ticketTypeId: 't1', unitPriceMinor: 5000 }]),
        },
        $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      } as never,
      {} as never,
      {} as never,
      { isPlatformAdmin: jest.fn().mockReturnValue(false) } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn(), sendCritical: jest.fn() } as never,
      new MetricsService(),
      { issueCreditNote: jest.fn() } as never,
    );

    // The account route's own ownership check now passes on the strength of the claim alone.
    const refund = await refunds.request(ACCOUNT, { bookingId: 'bk-1', reason: 'change of plan' });
    expect(refund).toMatchObject({ requestedByUserId: 'u1', amountMinor: 5000 });
  });

  it('serves its receipt through the ACCOUNT route, with no further change', async () => {
    const receipts = {
      document: jest.fn().mockResolvedValue({
        receipt: { organizationId: 'org-1', bookingId: 'bk-1', number: DOCUMENT.number },
        document: DOCUMENT,
      }),
    };
    const assertMember = jest.fn().mockRejectedValue(new Error('should not be consulted'));
    const controller = new ReceiptsController(
      receipts as never,
      { booking: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) } } as never,
      { assertMember } as never,
    );

    await expect(controller.get(ACCOUNT, 'rc-1')).resolves.toEqual(DOCUMENT);
    // Allowed as the BUYER, not by falling through to an organization membership check.
    expect(assertMember).not.toHaveBeenCalled();
  });
});
