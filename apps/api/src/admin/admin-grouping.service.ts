import { HttpStatus, Injectable } from '@nestjs/common';
import { marketSpellings } from '@eticketsgo/shared-types';
import {
  COUNTRY_COLUMNS,
  countryGroupLabel,
  countryKeySql,
  type CountryFilterable,
} from './country-filter';
import { dayRangeSql } from './list-filters';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * The admin queues, counted by the thing an operator is actually asking about.
 *
 * ── WHY A SUMMARY AND NOT ANOTHER FILTER ───────────────────────────────────────────
 * Every admin list already filters and searches, and every one of them answers the same
 * question: "show me the next fifteen rows". That is the right answer to "find this booking"
 * and the wrong answer to "how are we doing in India", "which organizer is generating the
 * refunds" or "is this one event responsible for all of it" - questions that need the shape of
 * the whole set, not a page of it.
 *
 * So this returns one row per GROUP with a count and, where the resource is money, a total per
 * currency. The list underneath then scopes to a group, so the summary answers "where should I
 * look" and the list answers "at what".
 *
 * ── WHY RAW SQL ────────────────────────────────────────────────────────────────────
 * A country is not a column on anything here. It lives on the venue, reached through the
 * event, and Prisma's `groupBy` cannot traverse a relation - it would mean loading every
 * matching row into memory and grouping in JavaScript, which is a table scan pretending to be
 * an aggregate. One SQL statement with the joins does the work where the data is.
 *
 * Every value is a positional parameter. The only strings that reach the SQL text are column
 * names chosen from the tables in this file by exact match, never taken from a caller.
 */

/** What can be listed, and what each one can be grouped by. */
export const GROUPABLE = {
  bookings: ['country', 'organizer', 'event'],
  payments: ['country', 'organizer', 'event', 'currency'],
  refunds: ['country', 'organizer', 'event', 'currency'],
  events: ['country', 'organizer'],
  organizers: ['country'],
  settlements: ['country', 'organizer', 'event', 'currency'],
} as const;

export type GroupableResource = keyof typeof GROUPABLE;
export type GroupKey = (typeof GROUPABLE)[GroupableResource][number];

export interface GroupRow {
  /** What to filter the list by to see these rows. Null when the group is "not recorded". */
  key: string | null;
  label: string;
  count: number;
  /** Money in the group, per currency. Empty for a resource that carries none. */
  totals: { currency: string; totalMinor: number }[];
}

/** What a caller may narrow a summary by, so it agrees with the list under it. */
export interface GroupFilters {
  status?: string;
  q?: string;
  /** ISO alpha-2, already validated. Matched in every stored spelling, like the list. */
  country?: string;
  /** The money queues' organizer, event and UTC day window. See `list-filters.ts`. */
  organizationId?: string;
  eventId?: string;
  from?: string;
  to?: string;
}

/*
  ── ONE `FROM` PER RESOURCE, NOT PER GROUPING ──────────────────────────────────────
  `bookings:organizer` does not need the venue in order to group by organizer, and joins it
  anyway. That is so FILTERS below can name any column the queue's own list can search: a search
  box that reaches the venue's city cannot be honoured by a query that never joined the venue, and
  a summary that ignored the search would disagree with the list under it.

  None of the extra joins can change a count, because every one of them follows a REQUIRED foreign
  key - `Event.venueId`, `Event.organizationId`, `Booking.eventId`, `Payment.bookingId`,
  `Refund.bookingId`, `Settlement.eventId` - so each row has exactly one match on the other side.
  The integration test compares every count against the real list and would catch it if a join
  ever multiplied rows.
*/
const BOOKING_FROM =
  '"Booking" b ' +
  'JOIN "Event" e ON e.id = b."eventId" ' +
  'JOIN "Venue" v ON v.id = e."venueId" ' +
  'JOIN "Organization" o ON o.id = b."organizationId"';

const PAYMENT_FROM =
  '"Payment" p ' +
  'JOIN "Booking" b ON b.id = p."bookingId" ' +
  'JOIN "Event" e ON e.id = b."eventId" ' +
  'JOIN "Venue" v ON v.id = e."venueId" ' +
  'JOIN "Organization" o ON o.id = b."organizationId"';

/*
  A refund reaches its money through the BOOKING, not through the payment.

  `Refund` carries `bookingId`, `organizationId` and `amountMinor`, no currency of its own, and no
  `paymentId` at all. So the currency is the booking's - which is also the currency the customer
  was charged in. Going via `Payment` would additionally drop every refund of a booking with no
  payment row, and that is exactly the cash-at-the-venue case.

  The organization comes from the REFUND, not from its booking: that is the column the refund
  queue itself is keyed on.
*/
const REFUND_FROM =
  '"Refund" r ' +
  'JOIN "Booking" b ON b.id = r."bookingId" ' +
  'JOIN "Event" e ON e.id = b."eventId" ' +
  'JOIN "Venue" v ON v.id = e."venueId" ' +
  'JOIN "Organization" o ON o.id = r."organizationId"';

const EVENT_FROM =
  '"Event" e ' +
  'JOIN "Venue" v ON v.id = e."venueId" ' +
  'JOIN "Organization" o ON o.id = e."organizationId"';

const SETTLEMENT_FROM =
  '"Settlement" s ' +
  'JOIN "Event" e ON e.id = s."eventId" ' +
  'JOIN "Venue" v ON v.id = e."venueId" ' +
  'JOIN "Organization" o ON o.id = s."organizationId"';

/**
 * How each resource reaches each grouping.
 *
 * `from` is the table and its joins; `key` and `label` are the grouped expression. Kept as one
 * table rather than a query per combination so that adding a resource is one row and cannot
 * quietly diverge in how it counts.
 */
/*
  `country: true` marks a grouping whose `key` is a stored country column. Such a group is the
  MARKET the value names, not the text as typed - "USA", "United States" and "US" are one group
  keyed `US` and labelled "United States" - and a value that names no market is its own group,
  labelled "Unknown (<value>)". `key` and `label` still name the column, and `grouped()` wraps it
  in `countryKeySql` and `countryGroupLabel`; see `country-filter.ts` for why the comparison is
  exactly the one the list's scope makes.
*/
const SHAPES: Record<
  string,
  {
    from: string;
    key: string;
    label: string;
    country?: true;
    money?: { amount: string; currency: string };
  }
> = {
  'bookings:country': {
    from: BOOKING_FROM,
    key: 'v.country',
    label: 'v.country',
    country: true,
    money: { amount: 'b."totalMinor"', currency: 'b.currency' },
  },
  'bookings:organizer': {
    from: BOOKING_FROM,
    key: 'o.id',
    // The id is the key and the name is only the label, because two organizations can share a
    // name and a filter built on one would quietly merge them.
    label: 'o.name',
    money: { amount: 'b."totalMinor"', currency: 'b.currency' },
  },
  'bookings:event': {
    from: BOOKING_FROM,
    key: 'e.id',
    label: 'e.title',
    money: { amount: 'b."totalMinor"', currency: 'b.currency' },
  },
  'payments:country': {
    from: PAYMENT_FROM,
    key: 'v.country',
    label: 'v.country',
    country: true,
    money: { amount: 'p."amountMinor"', currency: 'p.currency' },
  },
  'payments:organizer': {
    from: PAYMENT_FROM,
    key: 'o.id',
    label: 'o.name',
    money: { amount: 'p."amountMinor"', currency: 'p.currency' },
  },
  'payments:event': {
    from: PAYMENT_FROM,
    key: 'e.id',
    label: 'e.title',
    money: { amount: 'p."amountMinor"', currency: 'p.currency' },
  },
  /*
    By currency, so the console can say what a filtered ledger adds up to without adding rupees
    to dollars. One group per currency is exactly the "total per currency" the page shows above
    the list; the key is the stored value, which is what the list scopes by.
  */
  'payments:currency': {
    from: PAYMENT_FROM,
    key: 'p.currency',
    label: 'UPPER(p.currency)',
    money: { amount: 'p."amountMinor"', currency: 'p.currency' },
  },
  'refunds:country': {
    from: REFUND_FROM,
    key: 'v.country',
    label: 'v.country',
    country: true,
    money: { amount: 'r."amountMinor"', currency: 'b.currency' },
  },
  'refunds:organizer': {
    from: REFUND_FROM,
    key: 'o.id',
    label: 'o.name',
    money: { amount: 'r."amountMinor"', currency: 'b.currency' },
  },
  'refunds:event': {
    from: REFUND_FROM,
    key: 'e.id',
    label: 'e.title',
    money: { amount: 'r."amountMinor"', currency: 'b.currency' },
  },
  // A refund is paid back in its booking's currency; it has no currency column of its own.
  'refunds:currency': {
    from: REFUND_FROM,
    key: 'b.currency',
    label: 'UPPER(b.currency)',
    money: { amount: 'r."amountMinor"', currency: 'b.currency' },
  },
  'events:country': { from: EVENT_FROM, key: 'v.country', label: 'v.country', country: true },
  'events:organizer': { from: EVENT_FROM, key: 'o.id', label: 'o.name' },
  /*
    An organization's country is `registeredCountry` - where the business is registered, which is
    the answer an operator wants and the one the approval flow collects. It is nullable, because an
    organization that has not been through approval has not been asked yet, and those rows are a
    real group ("Not recorded") rather than something to hide.
  */
  'organizers:country': {
    from: '"Organization" o',
    key: 'o."registeredCountry"',
    label: 'o."registeredCountry"',
    country: true,
  },
  /*
    `payableMinor` is the settlement figure, not `grossSalesMinor`: it is what the organizer is
    owed after refunds, disputes, platform fees and reserve. There is no `netMinor` column.
  */
  'settlements:country': {
    from: SETTLEMENT_FROM,
    key: 'v.country',
    label: 'v.country',
    country: true,
    money: { amount: 's."payableMinor"', currency: 's.currency' },
  },
  'settlements:organizer': {
    from: SETTLEMENT_FROM,
    key: 'o.id',
    label: 'o.name',
    money: { amount: 's."payableMinor"', currency: 's.currency' },
  },
  'settlements:event': {
    from: SETTLEMENT_FROM,
    key: 'e.id',
    label: 'e.title',
    money: { amount: 's."payableMinor"', currency: 's.currency' },
  },
  /*
    The KEY stays raw and only the LABEL is upper-cased, and the two must not be swapped.

    `Settlement.currency` is stored lower-case on purpose: it is half of the `eventId_currency`
    unique key, so normalising it is what stops `INR` and `inr` becoming two settlement rows for
    one event. That makes it correct data and a poor label - an ISO 4217 code is written upper-case
    wherever a person reads it, and a chip saying "usd" beside one saying "India" looks unfinished.

    Upper-casing the key as well would be the quiet kind of bug: the list scopes with
    `{ currency: key }` against the stored value, so every chip would filter to nothing at all.
    The key/label split already exists for organizer id versus organizer name; this is the same
    split for the same reason.
  */
  'settlements:currency': {
    from: SETTLEMENT_FROM,
    key: 's.currency',
    label: 'UPPER(s.currency)',
    money: { amount: 's."payableMinor"', currency: 's.currency' },
  },
};

/**
 * The same filters each queue's LIST applies, so the two agree.
 *
 * ── THE DEFECT THIS EXISTS TO FIX ──────────────────────────────────────────────────
 * Without these, a summary counted every row of the resource while the list under it was filtered.
 * The refund queue opens on `status=REQUESTED`, so it read "India - 1 row" above an empty table:
 * the one refund in the database was already COMPLETED. The events queue opens on `UNDER_REVIEW`
 * and had the same problem. That is precisely the "group of 12, list of 9, and nothing on screen
 * says which is right" failure a grouped summary exists to prevent, and it took a browser to see.
 *
 * `search` mirrors the columns each list already searches - see each service's `adminList`.
 */
/*
  `organizer`, `event` and `created` exist only on the queues whose LIST takes the same filter, and
  each names the column that list filters on: the payment ledger's organizer is its booking's, a
  refund's is its own. A summary filtering a column its list does not would disagree with it.
*/
const FILTERS: Record<
  string,
  { status: string; search: string[]; organizer?: string; event?: string; created?: string }
> = {
  bookings: {
    status: 'b.status',
    search: ['b."buyerEmail"', 'b.reference'],
    organizer: 'b."organizationId"',
    event: 'b."eventId"',
    created: 'b."createdAt"',
  },
  payments: {
    status: 'p.status',
    search: ['p."providerRef"', 'b."buyerEmail"', 'b.reference'],
    organizer: 'b."organizationId"',
    event: 'b."eventId"',
    created: 'p."createdAt"',
  },
  refunds: {
    status: 'r.status',
    search: ['b."buyerEmail"', 'b.reference'],
    organizer: 'r."organizationId"',
    event: 'b."eventId"',
    created: 'r."createdAt"',
  },
  events: { status: 'e.status', search: ['e.title', 'o.name', 'v.city'] },
  organizers: { status: 'o.status', search: ['o.name', 'o.slug', 'o."legalName"'] },
  // The settlement queue has no search box; it filters by status, organization, event and date.
  settlements: {
    status: 's.status',
    search: [],
    organizer: 's."organizationId"',
    event: 's."eventId"',
    created: 's."createdAt"',
  },
};

/**
 * The `WHERE` clause for a summary, and the values that go with it.
 *
 * Values are positional parameters. `status` is compared as TEXT because these columns are
 * Postgres enums and the value arrives as a string - comparing an enum to an untyped parameter is
 * an "operator does not exist" error, which is the raw-SQL trap this codebase has hit before.
 */
function filterClause(resource: string, filters: GroupFilters): { sql: string; params: unknown[] } {
  const spec = FILTERS[resource];
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (!spec) return { sql: '', params };

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`${spec.status}::text = $${params.length}`);
  }
  if (filters.q && spec.search.length > 0) {
    params.push(`%${filters.q}%`);
    const at = params.length;
    /*
      ILIKE, to match the lists' `mode: 'insensitive'`. A case-sensitive summary over a
      case-insensitive list is the same disagreement in a subtler form: it would under-count a
      group whenever somebody searched in the wrong case, which is most of the time.
    */
    conditions.push(`(${spec.search.map((c) => `${c} ILIKE $${at}`).join(' OR ')})`);
  }
  /*
    The country filter, on the same column the list filters (`country-filter.ts`), compared
    lower-cased against every spelling of the market - the SQL form of the list's `in` +
    `mode: 'insensitive'`, and the same comparison a country GROUP is keyed by.
    A queue whose list takes no country has no column here, and ignores it the way its list does.
  */
  const countryColumn = COUNTRY_COLUMNS[resource as CountryFilterable];
  if (filters.country && countryColumn) {
    params.push(marketSpellings(filters.country));
    conditions.push(`LOWER(${countryColumn}) = ANY($${params.length}::text[])`);
  }
  if (filters.organizationId && spec.organizer) {
    params.push(filters.organizationId);
    conditions.push(`${spec.organizer} = $${params.length}`);
  }
  if (filters.eventId && spec.event) {
    params.push(filters.eventId);
    conditions.push(`${spec.event} = $${params.length}`);
  }
  if (spec.created) {
    conditions.push(...dayRangeSql(spec.created, filters.from, filters.to, params));
  }

  return { sql: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '', params };
}

/**
 * How many groups are worth returning.
 *
 * A summary is something an operator reads, so it stops being a summary somewhere around a
 * screenful. Ordered by count so the cap keeps the groups that matter, and the response says
 * when it truncated rather than quietly showing the top of a longer list.
 */
const MAX_GROUPS = 50;

@Injectable()
export class AdminGroupingService {
  constructor(private readonly prisma: PrismaService) {}

  async grouped(
    resource: string,
    groupBy: string,
    filters: GroupFilters = {},
  ): Promise<{
    resource: string;
    groupBy: string;
    groups: GroupRow[];
    truncated: boolean;
  }> {
    const allowed = (GROUPABLE as Record<string, readonly string[]>)[resource];
    if (!allowed) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Cannot group "${resource}". Try one of: ${Object.keys(GROUPABLE).join(', ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!allowed.includes(groupBy)) {
      /*
        Refused rather than silently falling back to a grouping that happens to work. "Group
        organizers by event" has no meaning, and answering it with something else would be a
        screen quietly showing a different question's answer.
      */
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `${resource} cannot be grouped by ${groupBy}. Try: ${allowed.join(', ')}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const shape = SHAPES[`${resource}:${groupBy}`];
    // Unreachable while GROUPABLE and SHAPES agree; asserted so a half-added resource fails
    // here rather than as a confusing SQL error.
    if (!shape) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `No query defined for ${resource} by ${groupBy}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const where = filterClause(resource, filters);
    /*
      A country grouping's key is computed, and its spelling lists are parameters too: appended
      after the filter's, so both statements below can share one parameter list. Grouped by
      position (`GROUP BY 1, 2`) so the CASE is written once and cannot drift from the SELECT.
    */
    const params = [...where.params];
    const keySql = shape.country ? countryKeySql(shape.key, params) : shape.key;
    const labelSql = shape.country ? keySql : shape.label;

    /*
      Two statements rather than one with a currency dimension in the same GROUP BY.

      A group's COUNT must not multiply when its money splits across currencies - an organizer
      selling in INR and USD is one organizer with two totals, not two organizers. So the count
      is grouped by the key alone and the money by key and currency, and they are stitched
      together below. Summing mixed currencies into one number is the defect this shape exists
      to make impossible; see the payouts that once added INR and USD as rupees.
    */
    const counts = await this.prisma.$queryRawUnsafe<
      { key: string | null; label: string | null; count: bigint }[]
    >(
      `SELECT ${keySql} AS key, ${labelSql} AS label, COUNT(*)::bigint AS count
         FROM ${shape.from}${where.sql}
        GROUP BY 1, 2
        ORDER BY COUNT(*) DESC
        LIMIT ${MAX_GROUPS + 1}`,
      ...params,
    );

    const money = shape.money
      ? await this.prisma.$queryRawUnsafe<
          { key: string | null; currency: string; total: bigint }[]
        >(
          `SELECT ${keySql} AS key, ${shape.money.currency} AS currency,
                  COALESCE(SUM(${shape.money.amount}), 0)::bigint AS total
             FROM ${shape.from}${where.sql}
            GROUP BY 1, 2`,
          ...params,
        )
      : [];

    const truncated = counts.length > MAX_GROUPS;
    const kept = counts.slice(0, MAX_GROUPS);

    const byKey = new Map<string, { currency: string; totalMinor: number }[]>();
    for (const row of money) {
      const k = row.key ?? '';
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push({ currency: row.currency, totalMinor: Number(row.total) });
    }

    return {
      resource,
      groupBy,
      groups: kept.map((row) => ({
        key: row.key,
        // A row whose venue has no country, or an organization with none recorded, is a real
        // group and is shown as one - hiding it would make the counts not add up to the list.
        label: shape.country ? countryGroupLabel(row.key) : (row.label ?? 'Not recorded'),
        count: Number(row.count),
        totals: (byKey.get(row.key ?? '') ?? []).sort((a, b) =>
          a.currency.localeCompare(b.currency),
        ),
      })),
      truncated,
    };
  }
}

/** Exported so the spec can prove GROUPABLE and SHAPES cannot drift apart. */
export const GROUPING_SHAPES = SHAPES;
/** Exported so the spec can prove a summary filters on the same columns as its list. */
export const GROUPING_FILTERS = FILTERS;
