import type { Prisma } from '@prisma/client';

/**
 * The advisory lock that serialises everything which decides who pays an organization's revenue.
 *
 * Payout generation took it first: two generates that both read "no open payout" each wrote one.
 * A provider transfer (`SettlementService.release`) and marking a payout paid take the SAME lock,
 * so a transfer and a ledger payout cannot both read "nobody has claimed this event" and both pay
 * it (AR-55). Transaction-scoped: it is released when the transaction commits or rolls back.
 *
 * The key is per organization, so one organization's money never waits on another's.
 */
export function payoutGenerateLockKey(organizationId: string): string {
  return `payout-generate:${organizationId}`;
}

export async function lockPayoutGeneration(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${payoutGenerateLockKey(organizationId)}))`;
}
