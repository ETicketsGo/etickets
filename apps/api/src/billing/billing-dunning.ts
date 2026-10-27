import { NotificationType } from '@eticketsgo/shared-types';
import type { AdminAudienceService } from '../notifications/admin-audience.service';

export type DunningStage = 'PAST_DUE' | 'GRACE' | 'GRACE_ENDING';

/** How close to the end of grace the last reminder goes. */
export const GRACE_ENDING_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** The stage a subscription's owners should have been told about at `now`, if any. */
export function dunningStageFor(
  s: { status: string; graceEndsAt: Date | null },
  now: Date,
): DunningStage | null {
  if (s.status === 'PAST_DUE') return 'PAST_DUE';
  if (s.status !== 'GRACE' || !s.graceEndsAt) return null;
  return s.graceEndsAt.getTime() - now.getTime() <= GRACE_ENDING_WINDOW_MS
    ? 'GRACE_ENDING'
    : 'GRACE';
}

/**
 * Tells the organization's owners that the plan payment failed. Through the transactional
 * notification path (BILLING_PAYMENT_FAILED is classified TRANSACTIONAL), deduplicated per
 * subscription, stage and period - so calling this every sweep sends each stage once.
 * Never throws: the owners fan-out logs and swallows its own failures.
 */
export async function sendDunning(
  audience: Pick<AdminAudienceService, 'notifyOrganizationOwners'> | null | undefined,
  input: {
    organizationId: string;
    subscriptionId: string;
    stage: DunningStage;
    planName: string;
    currentPeriodEnd: Date | null;
    graceEndsAt: Date | null;
  },
): Promise<number> {
  if (!audience) return 0;
  return audience.notifyOrganizationOwners(
    input.organizationId,
    NotificationType.BILLING_PAYMENT_FAILED,
    {
      subscriptionId: input.subscriptionId,
      stage: input.stage,
      planName: input.planName,
      periodEnd: (input.currentPeriodEnd ?? new Date(0)).toISOString(),
      deadline: input.graceEndsAt ? input.graceEndsAt.toISOString().slice(0, 10) : '',
    },
  );
}
