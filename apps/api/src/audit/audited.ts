import type { AuditService } from './audit.service';
import { currentRequest } from '../common/request-context';

export interface AuditedOperation {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  organizationId?: string | null;
  /** Facts about the operation. Never customer or payment data: counts, ids, status names. */
  metadata?: Record<string, unknown>;
}

/**
 * Run a privileged operational mutation and leave one audit row saying who did what to what, how
 * it ended and under which request.
 *
 * WHY A WRAPPER AND NOT A CALL AFTER THE WORK
 * A row written after the work records only the successes. The attempt that failed halfway is the
 * one an investigator needs, so the row is written either way: `outcome` is `ALLOWED` when the
 * operation ran to the end and `FAILED` when it threw (the error is rethrown unchanged, and only
 * its class name is written down, never its message, which may carry data).
 *
 * `correlationId` is the one every log line of the request carries (see `common/request-context`).
 * `audit` is optional so a service built by hand in a unit test needs no audit double.
 */
export async function audited<T>(
  audit: AuditService | undefined,
  op: AuditedOperation,
  run: () => Promise<T>,
  describe?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const correlationId = currentRequest()?.correlationId ?? null;
  const write = (outcome: 'ALLOWED' | 'FAILED', extra: Record<string, unknown>) =>
    audit?.record({
      actorUserId: op.actorUserId,
      organizationId: op.organizationId ?? null,
      action: op.action,
      entityType: op.entityType,
      entityId: op.entityId ?? null,
      correlationId,
      metadata: { ...op.metadata, ...extra, outcome },
    });
  let result: T;
  try {
    result = await run();
  } catch (err) {
    await write('FAILED', { errorClass: err instanceof Error ? err.constructor.name : 'Unknown' });
    throw err;
  }
  await write('ALLOWED', describe ? describe(result) : {});
  return result;
}
