import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

export const idParamSchema = z.object({
  id: z.string().cuid(),
});

export const emailSchema = z.string().trim().toLowerCase().email('A valid email is required.');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password is too long.');

/**
 * The launch market's zone.
 *
 * Used ONLY as a create-time convenience so an Indian operator does not have to pick their
 * own timezone from a list of six hundred, and as the migration's backfill value. It is never
 * a runtime fallback: once a cinema exists, its stored `timezone` is authoritative.
 */
export const DEFAULT_CINEMA_TIMEZONE = 'Asia/Kolkata';

/**
 * Is this a timezone the runtime can actually resolve?
 *
 * Asks Intl rather than checking against a hardcoded list. A list would need updating every
 * time the IANA database changes, and — worse — it could accept a name this Node build cannot
 * format with, which is the failure that matters: a cinema whose zone is unresolvable renders
 * every local time wrong rather than failing loudly.
 *
 * Deliberately rejects fixed offsets like "UTC+5:30". They look equivalent and are not: an
 * offset cannot know about daylight saving, so a venue stored that way silently drifts by an
 * hour twice a year in any market that observes it.
 */
export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.startsWith('UTC+') || value.startsWith('UTC-') || value.includes(' ')) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * An IANA timezone a cinema's local clock can be reckoned in.
 *
 * Anything the runtime cannot resolve is refused at the edge. Storing an unresolvable zone
 * would push the failure to every read — a schedule that throws when rendered is far harder
 * to diagnose than a create request that says "unknown timezone".
 */
export const ianaTimeZoneSchema = z.string().trim().min(1).max(64).refine(isValidIanaTimeZone, {
  message:
    'Must be an IANA timezone name such as "Asia/Kolkata" or "Australia/Sydney". Fixed offsets are not accepted because they cannot follow daylight saving.',
});
