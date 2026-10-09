import { Prisma } from '@prisma/client';
import { PHONE_ONLY_EMAIL_DOMAIN } from '@eticketsgo/shared-types';

/**
 * The organizer's attendee list for one event: who booked, as a query.
 *
 * ── WHY ONE BUILDER FOR THE SCREEN AND THE EXPORT ───────────────────────────────────
 * The page used to export by paging its own list endpoint from the browser and writing the
 * CSV itself. Two serialisers meant two chances to disagree about which rows a filter selects,
 * and a door list that silently differs from the screen it was exported from is worse than
 * none. Both the page and the CSV now read `attendeeRowsSql` filtered by `attendeeWhereSql`,
 * so "export what I am looking at" is true by construction, not by keeping two copies in step.
 *
 * ── WHY A ROW IS A TICKET, OR A BOOKING LINE THAT HAS NO TICKETS YET ───────────────
 * Tickets are issued only when a booking is confirmed. A list built from tickets alone could
 * never show a cash reservation that has not been paid at the counter, or a booking that was
 * cancelled before it was confirmed - and an organizer asking "who booked" needs both. So the
 * rows are every issued ticket (quantity 1, with its seat and check-in) plus, for a booking
 * with no tickets, one row per ticket line (quantity = how many it reserved).
 *
 * An EXPIRED booking with no tickets is left out: it is a hold somebody abandoned at checkout,
 * not a booking, and counting it would make every event look busier than it is.
 *
 * Raw SQL rather than the Prisma query API because the list is a UNION over two tables that
 * has to be filtered, counted, grouped and paged as one set. Paging two Prisma queries side by
 * side cannot produce a stable page boundary.
 */

/** The four states an organizer reasons in. Mapped from booking + ticket status below. */
export const ATTENDEE_STATES = ['CONFIRMED', 'PENDING', 'CANCELLED', 'REFUNDED'] as const;
export type AttendeeState = (typeof ATTENDEE_STATES)[number];

export const CHECK_IN_FILTERS = ['checked_in', 'not_checked_in'] as const;
export type CheckInFilter = (typeof CHECK_IN_FILTERS)[number];

export interface AttendeeFilter {
  sessionId?: string;
  ticketTypeId?: string;
  status?: AttendeeState;
  checkIn?: CheckInFilter;
  q?: string;
}

/** One row as the database returns it, before any redaction. */
export interface AttendeeDbRow {
  rowId: string;
  ticketId: string | null;
  serial: string | null;
  ticketStatus: string | null;
  bookingId: string;
  reference: string | null;
  bookedAt: Date;
  bookingStatus: string;
  paymentMethod: string;
  cashCollected: boolean;
  paymentStatus: string | null;
  buyerName: string;
  buyerEmail: string;
  holderName: string | null;
  holderEmail: string | null;
  attendeePhone: string | null;
  ticketTypeId: string;
  ticketType: string;
  quantity: number;
  sessionId: string;
  sessionStartsAt: Date;
  seatLabel: string | null;
  checkedIn: boolean;
  checkedInAt: Date | null;
  state: AttendeeState;
}

/**
 * Every attendee row of one event, with its organizer-facing `state`, as the CTE
 * `attendee_rows`. Follow it with a SELECT from `attendee_rows`.
 *
 * State precedence: a refund beats a cancellation beats "pending" beats "confirmed". A ticket
 * carries its own status (one ticket of a booking can be refunded while the others stand), so
 * the ticket's status is read first and the booking's fills in where the ticket is still live
 * or does not exist yet. DISPUTED and PARTIALLY_REFUNDED bookings keep their live tickets
 * CONFIRMED - the person can still walk in - and the payment column says what is going on.
 */
export function attendeeRowsSql(eventId: string): Prisma.Sql {
  return Prisma.sql`
    WITH base AS (
      SELECT
        t.id                         AS "rowId",
        t.id                         AS "ticketId",
        t.serial                     AS "serial",
        t.status::text               AS "ticketStatus",
        b.id                         AS "bookingId",
        b.reference                  AS "reference",
        b."createdAt"                AS "bookedAt",
        b.status::text               AS "bookingStatus",
        b."paymentMethod"::text      AS "paymentMethod",
        (b."cashCollectedAt" IS NOT NULL) AS "cashCollected",
        p.status::text               AS "paymentStatus",
        b."buyerName"                AS "buyerName",
        b."buyerEmail"               AS "buyerEmail",
        t."holderName"               AS "holderName",
        t."holderEmail"              AS "holderEmail",
        t."attendeePhone"            AS "attendeePhone",
        t."ticketTypeId"             AS "ticketTypeId",
        tt.name                      AS "ticketType",
        1                            AS "quantity",
        t."eventSessionId"           AS "sessionId",
        s."startsAt"                 AS "sessionStartsAt",
        t."seatLabel"                AS "seatLabel",
        (t.status::text = 'CHECKED_IN') AS "checkedIn",
        (
          SELECT max(c."createdAt") FROM "CheckIn" c
          WHERE c."ticketId" = t.id AND c.result::text = 'SUCCESS' AND c.reversed = false
        )                            AS "checkedInAt"
      FROM "Ticket" t
      JOIN "Booking" b       ON b.id = t."bookingId"
      JOIN "TicketType" tt   ON tt.id = t."ticketTypeId"
      JOIN "EventSession" s  ON s.id = t."eventSessionId"
      LEFT JOIN "Payment" p  ON p."bookingId" = b.id
      WHERE b."eventId" = ${eventId}

      UNION ALL

      SELECT
        bi.id, NULL, NULL, NULL,
        b.id, b.reference, b."createdAt", b.status::text, b."paymentMethod"::text,
        (b."cashCollectedAt" IS NOT NULL), p.status::text,
        b."buyerName", b."buyerEmail",
        NULL, NULL, NULL,
        bi."ticketTypeId", tt.name, bi.quantity,
        b."eventSessionId", s."startsAt",
        NULL, false, NULL
      FROM "BookingItem" bi
      JOIN "Booking" b       ON b.id = bi."bookingId"
      JOIN "TicketType" tt   ON tt.id = bi."ticketTypeId"
      JOIN "EventSession" s  ON s.id = b."eventSessionId"
      LEFT JOIN "Payment" p  ON p."bookingId" = b.id
      WHERE b."eventId" = ${eventId}
        AND bi."ticketTypeId" IS NOT NULL
        AND b.status::text <> 'EXPIRED'
        AND NOT EXISTS (SELECT 1 FROM "Ticket" t2 WHERE t2."bookingId" = b.id)
    ),
    attendee_rows AS (
      SELECT base.*,
        CASE
          WHEN "ticketStatus" = 'REFUNDED' OR "bookingStatus" = 'REFUNDED' THEN 'REFUNDED'
          WHEN "ticketStatus" IN ('CANCELLED', 'VOID')
            OR "bookingStatus" IN ('CANCELLED', 'EXPIRED') THEN 'CANCELLED'
          WHEN "bookingStatus" = 'PENDING_PAYMENT' THEN 'PENDING'
          ELSE 'CONFIRMED'
        END AS "state"
      FROM base
    )`;
}

/** Escapes LIKE wildcards so a search for "100%" or "a_b" means what it says. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * An email column that may be SEARCHED: never a phone-only account's placeholder.
 *
 * The placeholder is built from the phone number, so letting a search match it would turn
 * the search box into a way of reading a buyer's phone number one digit at a time, even
 * though the column itself is never displayed.
 */
function searchableEmail(column: Prisma.Sql, pattern: string): Prisma.Sql {
  const reserved = `%@${PHONE_ONLY_EMAIL_DOMAIN}`;
  const reservedSub = `%.${PHONE_ONLY_EMAIL_DOMAIN}`;
  return Prisma.sql`(${column} ILIKE ${pattern}
    AND lower(${column}) NOT LIKE ${reserved}
    AND lower(${column}) NOT LIKE ${reservedSub})`;
}

export interface WhereOptions {
  /** Leave the status filter out, so per-status totals can be counted under the rest. */
  ignoreStatus?: boolean;
  /** Whether email addresses take part in the search (not for gate staff, who cannot see them). */
  searchEmails: boolean;
}

/** The WHERE clause over `attendee_rows`, shared by the page, the totals and the export. */
export function attendeeWhereSql(filter: AttendeeFilter, options: WhereOptions): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (filter.sessionId) clauses.push(Prisma.sql`"sessionId" = ${filter.sessionId}`);
  if (filter.ticketTypeId) clauses.push(Prisma.sql`"ticketTypeId" = ${filter.ticketTypeId}`);
  if (filter.status && !options.ignoreStatus) clauses.push(Prisma.sql`"state" = ${filter.status}`);
  if (filter.checkIn === 'checked_in') clauses.push(Prisma.sql`"checkedIn" = true`);
  if (filter.checkIn === 'not_checked_in') clauses.push(Prisma.sql`"checkedIn" = false`);
  const term = filter.q?.trim();
  if (term) {
    const pattern = likePattern(term);
    const ors: Prisma.Sql[] = [
      Prisma.sql`"buyerName" ILIKE ${pattern}`,
      Prisma.sql`"holderName" ILIKE ${pattern}`,
      Prisma.sql`"reference" ILIKE ${pattern}`,
      Prisma.sql`"serial" ILIKE ${pattern}`,
    ];
    if (options.searchEmails) {
      ors.push(searchableEmail(Prisma.sql`"buyerEmail"`, pattern));
      ors.push(searchableEmail(Prisma.sql`"holderEmail"`, pattern));
    }
    clauses.push(Prisma.sql`(${Prisma.join(ors, ' OR ')})`);
  }
  return Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`;
}

/**
 * Newest booking first, a booking's rows together. Every key is descending so the export can
 * page with a single row comparison (keyset), which stays fast at any depth where OFFSET would
 * rescan everything before it on each page.
 */
export const ATTENDEE_ORDER = Prisma.sql`ORDER BY "bookedAt" DESC, "bookingId" DESC, "rowId" DESC`;

export interface AttendeeCursor {
  bookedAt: Date;
  bookingId: string;
  rowId: string;
}

/** The keyset condition for "rows after this one" in `ATTENDEE_ORDER`. */
export function afterCursorSql(cursor: AttendeeCursor | null): Prisma.Sql {
  if (!cursor) return Prisma.empty;
  /*
    The time goes in as text cast to `timestamp`. The column has no zone, and a JS Date bound
    directly is sent as `timestamptz`, which Postgres would shift by the session's zone before
    comparing - silently skipping or repeating rows at a page boundary on any server not in UTC.
  */
  const at = cursor.bookedAt.toISOString();
  return Prisma.sql`AND ("bookedAt", "bookingId", "rowId") < (${at}::timestamp, ${cursor.bookingId}, ${cursor.rowId})`;
}
