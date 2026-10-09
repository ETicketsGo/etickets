import { z } from 'zod';
import { countryFilterField } from './country-filter';

/**
 * The filters the finance and operations queues share: market, organizer, event and a date
 * window.
 *
 * ── WHY ONE FILE ───────────────────────────────────────────────────────────────────
 * Payments, refunds, settlements, support and the audit log each live in their own module, and
 * each would otherwise grow its own idea of what "from 1 October" means. Two of those ideas
 * disagreeing by a day is the kind of defect nobody sees: the refund queue and the payment
 * ledger, filtered to the same week, quietly cover different weeks. So the parsing and the
 * window both live here, and every list and every summary reads them from here.
 *
 * ── WHY THE DATES ARE DAYS IN UTC ──────────────────────────────────────────────────
 * The value lives in the URL, so a link sent from Hyderabad to a colleague in Toronto must mean
 * the same rows for both of them. A calendar day only does that if it is a day in ONE zone, and
 * every timestamp in the database is UTC already. The console labels the fields "(UTC)" so the
 * operator is not left to guess.
 *
 * Both ends are inclusive: "to 9 October" means the whole of the 9th. The window is built as
 * `>= from 00:00` and `< the day after to`, which is the same thing without the
 * 23:59:59.999 arithmetic that misses the last millisecond on a database with finer precision.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day, `YYYY-MM-DD`, that actually exists. "2026-02-30" is a 400, not 2 March. */
export const dayField = z
  .string()
  .trim()
  .regex(DAY, 'Use a date as YYYY-MM-DD, for example 2026-10-01.')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    // `Date` rolls an impossible day over into the next month; round-tripping catches that.
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'That date does not exist.')
  .optional();

/**
 * An organizer or event id from the URL.
 *
 * Not `.cuid()`: seeded and imported rows do not all carry cuids, and a filter that refused a
 * real id would be a filter that cannot select a real organizer. What it does refuse is anything
 * that could not be an id at all, so a mangled link is a 400 rather than an empty list that
 * reads as "this organizer sold nothing".
 */
export const idField = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'That is not an id.')
  .optional();

/** The five shared filters, for a controller's query schema to spread. */
export const listFilterFields = {
  country: countryFilterField,
  organizationId: idField,
  eventId: idField,
  from: dayField,
  to: dayField,
};

export interface ListFilters {
  /** ISO alpha-2, upper-case, already validated. */
  country?: string;
  organizationId?: string;
  eventId?: string;
  /** `YYYY-MM-DD`, inclusive, UTC. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive, UTC. */
  to?: string;
}

/**
 * A window whose end is before its start is refused rather than answered with nothing.
 *
 * An empty list is a real answer on these screens ("no refunds this week"), so an impossible
 * window must not be able to produce one.
 */
export function refineDateOrder(v: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (v.from && v.to && v.from > v.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'The end date is before the start date.',
    });
  }
}

/** The first instant of the day after `day`, in UTC. */
function dayAfter(day: string): Date {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * The Prisma range for a `createdAt`-style column, or null when no window was asked for.
 *
 * Inclusive of both days, as described above.
 */
export function dayRangeWhere(from?: string, to?: string): { gte?: Date; lt?: Date } | null {
  if (!from && !to) return null;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
    ...(to ? { lt: dayAfter(to) } : {}),
  };
}

/**
 * The same window as SQL, for the grouped summaries' raw queries.
 *
 * Compared against the bare `timestamp` Prisma stores (UTC, no zone), so the parameters are
 * passed as zone-less timestamps too. A `timestamptz` parameter would be shifted by the
 * database session's time zone, and a summary on a server set to Asia/Kolkata would start its
 * day five and a half hours early while the list beside it did not.
 */
export function dayRangeSql(
  column: string,
  from: string | undefined,
  to: string | undefined,
  params: unknown[],
): string[] {
  const conditions: string[] = [];
  if (from) {
    params.push(`${from} 00:00:00`);
    conditions.push(`${column} >= $${params.length}::timestamp`);
  }
  if (to) {
    params.push(`${dayAfter(to).toISOString().slice(0, 10)} 00:00:00`);
    conditions.push(`${column} < $${params.length}::timestamp`);
  }
  return conditions;
}

/** Drops the fragments that narrow nothing, so `AND: [...]` only holds real conditions. */
export function allOf(
  ...parts: (Record<string, unknown> | null | undefined | false)[]
): Record<string, unknown>[] {
  return parts.filter(
    (p): p is Record<string, unknown> => !!p && typeof p === 'object' && Object.keys(p).length > 0,
  );
}
