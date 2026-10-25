import type { Prisma } from '@prisma/client';

/**
 * Readable references for support requests: `ETG-SUP-<YEAR>-<SEQ>`, e.g. `ETG-SUP-2026-000142`.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * The acknowledgement used to say "Your reference is cmvncaxg10015uo2zxo94825e": the row's
 * database id. Nobody can read that out on the phone or type it back without a mistake. The id
 * stays the primary key and is still accepted by the admin search, so references in older mails
 * keep working; this is only the name a person is given.
 *
 * ── HOW A NUMBER IS TAKEN ──────────────────────────────────────────────────────────
 * - Year: the UTC year of the request's `createdAt`. 23:59:59 on 31 December UTC is the old
 *   year; 00:00:00 on 1 January UTC is the new one, whatever the sender's time zone.
 * - Sequence: per year, restarting at 000001, six digits zero-padded and growing past six
 *   rather than wrapping.
 * - Source: the database function `etg_next_reference_value('SUP-<YEAR>')`, one
 *   `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on `ReadableReferenceCounter`, called inside
 *   the transaction that inserts the request. The row lock serialises concurrent requests and a
 *   rolled-back insert gives its number back. Never random, never max()+1.
 *
 * The same function backs a BEFORE INSERT trigger that fills the reference for any insert that
 * does not carry one (an older API during the rollout), so both paths draw from one counter.
 */
export const SUPPORT_REFERENCE_PREFIX = 'ETG-SUP';

/** The counter scope for a year: `SUP-2026`. */
export function supportReferenceScope(year: number): string {
  return `SUP-${year}`;
}

/** The UTC year a request created at `at` is numbered in. */
export function supportReferenceYear(at: Date): number {
  return at.getUTCFullYear();
}

/** `ETG-SUP-2026-000142`. Six digits at least; a seventh is added, never a number cut. */
export function formatSupportReference(year: number, seq: number): string {
  return `${SUPPORT_REFERENCE_PREFIX}-${year}-${String(seq).padStart(6, '0')}`;
}

/**
 * Takes the next reference for a request created at `at`. Must run inside the transaction that
 * inserts the request, so the number and the row commit or roll back together.
 */
export async function assignSupportReference(
  tx: Prisma.TransactionClient,
  at: Date,
): Promise<string> {
  const year = supportReferenceYear(at);
  const rows = await tx.$queryRaw<{ value: number }[]>`
    SELECT "etg_next_reference_value"(${supportReferenceScope(year)}) AS value`;
  const value = Number(rows[0]?.value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`support reference counter returned no value for ${year}`);
  }
  return formatSupportReference(year, value);
}

const LOOSE_REFERENCE = /^ETG[-\s]?SUP[-\s]?(\d{4})[-\s]?(\d{1,9})$/i;

/**
 * The canonical reference a search term means, or null when it is not one.
 *
 * Accepts what people actually type: any case, with or without the dashes
 * (`etg-sup-2026-000142`, `ETGSUP2026000142`), and a sequence without its leading zeros
 * (`ETG-SUP-2026-142`).
 */
export function canonicalSupportReference(term: string): string | null {
  const m = LOOSE_REFERENCE.exec(term.trim());
  if (!m) return null;
  return formatSupportReference(Number(m[1]), Number(m[2]));
}
