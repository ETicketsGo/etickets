import { Prisma } from '@prisma/client';
import type { AppliedFeePolicy } from './fee-policy';

/**
 * Order limits on a platform fee policy - counted when the hold is taken, given back if the
 * hold is never paid.
 *
 * ── WHY AT THE HOLD AND NOT AT CONFIRMATION ─────────────────────────────────────────────
 * The customer is quoted, and the Payment row is created for, the waived price when the hold
 * is taken. If the limit were only counted at confirmation, ten checkouts racing for the last
 * redemption would all be priced with the waiver and all confirm - the limit would be a
 * suggestion. (That is exactly the weakness the coupon cap carries today; see
 * `BookingsService.couponsDisabled`.) Reserving at the hold, with a conditional UPDATE inside
 * the hold's own transaction, makes the limit exact: Postgres serialises the row, the update
 * only matches while `usedOrders < maxOrders`, and a CHECK constraint backs it.
 *
 * ── WHAT GIVES A REDEMPTION BACK ───────────────────────────────────────────────────────
 *   - an unpaid hold that expires, or that its buyer cancels, or that a cancelled show
 *     expires: `releaseFeePolicyRedemption`, called from the one claim-first release every
 *     one of those paths uses (`inventory/expire-pending-booking.ts`), so it runs exactly once;
 *   - NOTHING after confirmation. A confirmed booking that is later refunded or cancelled has
 *     used its redemption. Re-granting it would let a waiver be cycled by buying and
 *     refunding, and the refund already returns the money the customer paid.
 *
 * ── UNLIMITED POLICIES ──────────────────────────────────────────────────────────────────
 * Not counted and not locked. An organizer-wide waiver on an on-sale would otherwise turn one
 * row into a lock every checkout for that organizer queues on. The hold still re-reads the
 * policy inside its transaction, so a policy deactivated after the quote is not applied.
 */

/** The policy priced into this checkout is no longer available; price it again. */
export class FeePolicyUnavailableError extends Error {
  constructor(readonly policyId: string) {
    super(`Platform fee policy ${policyId} is no longer available.`);
    this.name = 'FeePolicyUnavailableError';
  }
}

type Tx = Prisma.TransactionClient;

/**
 * Take one order from `policy` inside the hold's transaction, or throw
 * `FeePolicyUnavailableError` when it can no longer price this sale.
 */
export async function reserveFeePolicyRedemption(
  tx: Tx,
  policy: AppliedFeePolicy,
  at: Date,
): Promise<void> {
  if (policy.maxOrders == null) {
    const still = await tx.platformFeePolicy.findFirst({
      where: {
        id: policy.id,
        status: 'ACTIVE',
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
      },
      select: { id: true },
    });
    if (!still) throw new FeePolicyUnavailableError(policy.id);
    return;
  }

  const rows = await tx.$queryRaw<
    { usedOrders: number; maxOrders: number | null; status: string }[]
  >(Prisma.sql`
    UPDATE "PlatformFeePolicy"
       SET "usedOrders" = "usedOrders" + 1,
           "status" = CASE WHEN "usedOrders" + 1 >= "maxOrders"
                           THEN 'EXHAUSTED'::"PlatformFeePolicyStatus"
                           ELSE "status" END,
           "updatedAt" = now()
     WHERE "id" = ${policy.id}
       AND "status" = 'ACTIVE'
       AND "maxOrders" IS NOT NULL
       AND "usedOrders" < "maxOrders"
       AND "startsAt" <= ${at}
       AND ("endsAt" IS NULL OR "endsAt" > ${at})
    RETURNING "usedOrders", "maxOrders", "status"::text AS "status"`);
  if (rows.length !== 1) throw new FeePolicyUnavailableError(policy.id);

  // The order that used the last redemption: say so in the policy's history, in the same
  // transaction, so the history and the counter cannot disagree.
  if (rows[0]!.status === 'EXHAUSTED') {
    await tx.platformFeePolicyEvent.create({
      data: {
        policyId: policy.id,
        action: 'EXHAUSTED',
        actorUserId: null,
        reason: 'Every order in the limit is taken.',
        snapshot: { usedOrders: rows[0]!.usedOrders, maxOrders: rows[0]!.maxOrders },
      },
    });
  }
}

/**
 * Give back the redemption an unpaid booking reserved, inside the transaction that released
 * it. A no-op for a booking priced without a policy or under an unlimited one.
 *
 * An EXHAUSTED policy goes back to ACTIVE, because it has room again. An INACTIVE one stays
 * INACTIVE: the count is corrected, the policy is not switched back on.
 */
export async function releaseFeePolicyRedemption(tx: Tx, feePolicyId: string): Promise<void> {
  const locked = await tx.$queryRaw<{ status: string; usedOrders: number }[]>(Prisma.sql`
    SELECT "status"::text AS "status", "usedOrders"
      FROM "PlatformFeePolicy"
     WHERE "id" = ${feePolicyId} AND "maxOrders" IS NOT NULL
     FOR UPDATE`);
  const row = locked[0];
  if (!row || row.usedOrders <= 0) return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "PlatformFeePolicy"
       SET "usedOrders" = "usedOrders" - 1,
           "status" = CASE WHEN "status" = 'EXHAUSTED'
                           THEN 'ACTIVE'::"PlatformFeePolicyStatus"
                           ELSE "status" END,
           "updatedAt" = now()
     WHERE "id" = ${feePolicyId}`);
  if (row.status === 'EXHAUSTED') {
    await tx.platformFeePolicyEvent.create({
      data: {
        policyId: feePolicyId,
        action: 'REOPENED',
        actorUserId: null,
        reason: 'An unpaid hold was released, so one order is available again.',
        snapshot: { usedOrders: row.usedOrders - 1 },
      },
    });
  }
}
