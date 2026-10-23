import type { OpsAlert } from './ops-alert.service';
import {
  adminAccessChangedAlert,
  adminMfaLockoutAlert,
  refreshTokenReuseAlert,
} from './ops-alert-messages';

/**
 * The fields of an AuditEntry (audit/audit.service.ts) this file reads. Declared here rather
 * than imported, because AuditService imports this file and the repo forbids import cycles
 * (madge, `npm run deps:check`), type-only ones included.
 */
export interface SecurityAuditEntry {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The audit actions that should also wake a person, and the alert each one becomes.
 *
 * ── WHY FROM THE AUDIT ENTRY ──────────────────────────────────────────────────────
 * Each of these events already writes an audit row, at exactly the point where it is decided,
 * and that row is the record an operator will read. Raising the alert from the same entry means
 * the alert can never describe something the log does not hold, and the code that decides (MFA,
 * sessions, staff management) does not have to learn about alerting. AuditService.record calls
 * this after its write; an entry written inside a transaction is raised only after that
 * transaction commits (AuditService.afterCommit), so a change that rolled back is never mailed.
 *
 * Every builder reads ids and permission codes from the entry, never `metadata.email`, the
 * client address or a reason typed by staff: the alert says where to look, the log says who.
 *
 * Returns null for every other action, which is almost all of them.
 */
export function securityAlertForAudit(entry: SecurityAuditEntry): OpsAlert | null {
  const meta = entry.metadata ?? {};
  switch (entry.action) {
    case 'AUTH_TOKEN_REUSE_DETECTED':
      return refreshTokenReuseAlert({ userId: entry.actorUserId ?? null });
    case 'MFA_LOCKED_OUT':
      return adminMfaLockoutAlert({
        userId: entry.entityId ?? entry.actorUserId ?? null,
        minutes: meta.minutes,
      });
    case 'ADMIN_PERMISSIONS_CHANGED': {
      const before = codes(meta.before);
      const after = codes(meta.after);
      return adminAccessChangedAlert({
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        targetUserId: entry.entityId ?? null,
        added: after.filter((p) => !before.includes(p)),
        removed: before.filter((p) => !after.includes(p)),
      });
    }
    case 'ADMIN_ROLE_GRANTED':
    case 'ADMIN_ROLE_REVOKED':
      return adminAccessChangedAlert({
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        targetUserId: entry.entityId ?? null,
      });
    case 'USER_SUSPENDED':
    case 'USER_REINSTATED':
      // Support suspends customers as routine work. Only a back-office account is news.
      if (meta.backOffice !== true) return null;
      return adminAccessChangedAlert({
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        targetUserId: entry.entityId ?? null,
      });
    default:
      return null;
  }
}

/** Permission codes from a metadata array; anything else is dropped rather than printed. */
function codes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(v));
}
