import type {
  AdminEventRow,
  AdminStaffMember,
  DiscrepancyRow,
  OrgEventDetail,
} from '@eticketsgo/web-kit';

/*
  ── THE ADMIN PROPOSAL'S RULES, WITHOUT A BROWSER ──────────────────────────────────
  docs/design/ADMIN-PROPOSAL.md. The prototype screens under `app/proposal` hold every number
  to three rules: it says what it counts, over which window, and in which currency; it is
  never added across currencies; and the screen says when it was read. The pieces of that
  which are logic rather than layout live here, so they are tested once.

  Nothing here invents a figure. Every input is a field an existing endpoint already returns.
*/

/** How long something has waited, in the largest whole unit: "3 days", "5 hours". */
export function ageWords(fromIso: string, now: Date): string {
  const ms = now.getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** Whole days between two instants, for "older than N days" thresholds. */
export function ageDays(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

/** The oldest timestamp in a list, or null for an empty one. */
export function oldest(isoDates: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const d of isoDates) {
    if (d && (best === null || d < best)) best = d;
  }
  return best;
}

// ─── Reconciliation ────────────────────────────────────────────────────────────

/*
  The same words the live reconciliation page uses (app/admin/finance-reconciliation), kept
  here so the prototype does not reach into a page module. A type with no entry keeps its raw
  name: a new detector must be legible the day it ships.
*/
export const DISCREPANCY_TYPE_LABELS: Record<string, string> = {
  PAYMENT_MISSING_INTERNALLY: 'Payment we have no record of',
  PAYMENT_MISSING_AT_PROVIDER: 'Payment the provider has no record of',
  AMOUNT_MISMATCH: 'Amount does not match',
  CURRENCY_MISMATCH: 'Currency does not match',
  DUPLICATE_CAPTURE: 'Charged twice',
  REFUND_MISMATCH: 'Refund does not match',
  CHARGEBACK: 'Chargeback',
  SETTLEMENT_MISMATCH: 'Settlement does not match',
  GATEWAY_FEE_MISMATCH: 'Provider fee does not match',
  ORGANIZER_PAYABLE_MISMATCH: 'Organizer amount does not match',
};

export function discrepancyTypeLabel(type: string): string {
  return DISCREPANCY_TYPE_LABELS[type] ?? type;
}

export interface CurrencyExposure {
  /** Null when the detector filed rows without a currency: shown apart, never guessed. */
  currency: string | null;
  count: number;
  /** Sum of `amountMinor` within this ONE currency; rows with no amount are counted, not summed. */
  amountMinor: number;
  rowsWithoutAmount: number;
  oldestAt: string | null;
}

/**
 * Unresolved discrepancies (OPEN and ASSIGNED) grouped by currency, biggest count first.
 *
 * Adding amounts is only ever done inside one currency. A row with no currency is its own
 * group, because putting it in INR because INR is the biggest market would be a wrong amount
 * in a right-looking symbol.
 */
export function exposureByCurrency(rows: readonly DiscrepancyRow[]): CurrencyExposure[] {
  const groups = new Map<string, CurrencyExposure>();
  for (const r of rows) {
    if (r.status !== 'OPEN' && r.status !== 'ASSIGNED') continue;
    const cur = r.currency?.trim().toUpperCase() || null;
    const key = cur ?? '';
    const g = groups.get(key) ?? {
      currency: cur,
      count: 0,
      amountMinor: 0,
      rowsWithoutAmount: 0,
      oldestAt: null,
    };
    g.count += 1;
    if (r.amountMinor == null) g.rowsWithoutAmount += 1;
    else g.amountMinor += Math.abs(r.amountMinor);
    if (g.oldestAt === null || r.createdAt < g.oldestAt) g.oldestAt = r.createdAt;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Unresolved rows by type, most common first: where the detector keeps finding the same thing. */
export function countByType(rows: readonly DiscrepancyRow[]): { type: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'OPEN' && r.status !== 'ASSIGNED') continue;
    m.set(r.type, (m.get(r.type) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

// ─── Event approvals ───────────────────────────────────────────────────────────

export interface PriceSpan {
  currency: string;
  minMinor: number;
  maxMinor: number;
}

/** Ticket prices per currency across every session. Never merged across currencies. */
export function priceSpans(
  detail: Pick<OrgEventDetail, 'sessions'> | null | undefined,
): PriceSpan[] {
  const m = new Map<string, PriceSpan>();
  for (const s of detail?.sessions ?? []) {
    for (const t of s.ticketTypes ?? []) {
      const span = m.get(t.currency);
      if (!span)
        m.set(t.currency, { currency: t.currency, minMinor: t.priceMinor, maxMinor: t.priceMinor });
      else {
        span.minMinor = Math.min(span.minMinor, t.priceMinor);
        span.maxMinor = Math.max(span.maxMinor, t.priceMinor);
      }
    }
  }
  return [...m.values()];
}

export type SignalTone = 'critical' | 'caution' | 'info';
export interface RiskSignal {
  key: string;
  words: string;
  tone: SignalTone;
}

/**
 * What a reviewer should look at before deciding, as facts read from the row and the event.
 *
 * Each is something the reviewer can verify on the screen, not a score: "Starts in the past"
 * rather than "risk 72". Only fields the API already returns are used; anything that would
 * need a new field (organizer age, refund history) is listed in the proposal as a gap.
 */
export function riskSignals(
  row: Pick<AdminEventRow, 'firstSessionAt' | 'sessionCount'>,
  detail:
    | Pick<OrgEventDetail, 'sessions' | 'imagePath' | 'isFree' | 'reviewNote' | 'description'>
    | null
    | undefined,
  now: Date,
): RiskSignal[] {
  const out: RiskSignal[] = [];
  if (row.sessionCount === 0 || !row.firstSessionAt) {
    out.push({ key: 'no-session', words: 'No date: nobody could buy a ticket', tone: 'critical' });
  } else if (new Date(row.firstSessionAt).getTime() < now.getTime()) {
    out.push({ key: 'past', words: 'First date is in the past', tone: 'critical' });
  }
  if (detail) {
    const spans = priceSpans(detail);
    if (spans.length === 0) {
      out.push({ key: 'no-tickets', words: 'No ticket types yet', tone: 'caution' });
    } else if (!detail.isFree && spans.every((s) => s.maxMinor === 0)) {
      out.push({ key: 'zero-price', words: 'Paid event with only zero prices', tone: 'caution' });
    }
    if (spans.length > 1) {
      out.push({ key: 'currencies', words: 'Prices in more than one currency', tone: 'caution' });
    }
    if (!detail.imagePath) out.push({ key: 'no-image', words: 'No image', tone: 'info' });
    if (!detail.description?.trim()) {
      out.push({ key: 'no-description', words: 'No description', tone: 'info' });
    }
    if (detail.reviewNote)
      out.push({ key: 'resubmitted', words: 'Sent back before', tone: 'info' });
  }
  return out;
}

/** A rejection must say why: the organizer reads the note to fix the event. */
export function rejectionReasonError(note: string): string | null {
  const n = note.trim();
  if (n.length === 0)
    return 'Write the reason. The organizer sees it and needs it to fix the event.';
  if (n.length < 10) return 'Say a little more, so the organizer knows what to change.';
  return null;
}

// ─── Staff and access ──────────────────────────────────────────────────────────

export interface Preset {
  key: string;
  label: string;
  description: string;
  grants: string[];
}

export type Grant =
  | { kind: 'super' }
  | { kind: 'none' }
  | { kind: 'preset'; label: string }
  | { kind: 'preset-plus'; label: string; extra: string[] }
  | { kind: 'custom'; count: number };

/**
 * What a staff member holds, said as the preset it is, rather than as a list of capability
 * names. A grant that is exactly a preset is named; one that is a preset plus extras says
 * which extras (each extra is a decision somebody made, worth seeing); anything else is
 * "custom". The largest contained preset wins, so "Finance plus one" beats "Support plus six".
 */
export function describeGrant(
  member: Pick<AdminStaffMember, 'isSuperAdmin' | 'permissions'>,
  presets: readonly Preset[],
): Grant {
  if (member.isSuperAdmin) return { kind: 'super' };
  const held = new Set(member.permissions);
  if (held.size === 0) return { kind: 'none' };
  for (const p of presets) {
    if (p.grants.length === held.size && p.grants.every((g) => held.has(g))) {
      return { kind: 'preset', label: p.label };
    }
  }
  const contained = presets
    .filter((p) => p.grants.length > 0 && p.grants.every((g) => held.has(g)))
    .sort((a, b) => b.grants.length - a.grants.length)[0];
  if (contained) {
    const inPreset = new Set(contained.grants);
    return {
      kind: 'preset-plus',
      label: contained.label,
      extra: member.permissions.filter((p) => !inPreset.has(p)).sort(),
    };
  }
  return { kind: 'custom', count: held.size };
}

/** A capability constant as words: "FINANCE_RESOLVE" -> "Finance resolve". */
export function capabilityWords(cap: string): string {
  const w = cap.toLowerCase().replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * The audit actions that are about access rather than business, in the order a security
 * review reads them: an attack signal first, then changes to who may do what, then MFA.
 * Names as the audit log stores them (GET /admin/audit/summary lists every action held).
 */
export const ACCESS_ACTIONS = [
  'AUTH_TOKEN_REUSE_DETECTED',
  'AUTH_LOGIN_FAILED',
  'ADMIN_PERMISSIONS_CHANGED',
  'MFA_DEVICE_REPLACED',
  'MFA_RECOVERY_CODES_REGENERATED',
  'MFA_ENROLLMENT_COMPLETED',
] as const;

const ACCESS_WORDS: Record<string, string> = {
  AUTH_TOKEN_REUSE_DETECTED: 'Sign-in token used twice',
  AUTH_LOGIN_FAILED: 'Failed sign-in',
  ADMIN_PERMISSIONS_CHANGED: 'Staff duties changed',
  MFA_DEVICE_REPLACED: 'Authenticator replaced',
  MFA_RECOVERY_CODES_REGENERATED: 'New recovery codes made',
  MFA_ENROLLMENT_COMPLETED: 'Authenticator set up',
  AUTH_LOGIN: 'Signed in',
};

/** An audit action as words; an unknown one is spelled out from its name. */
export function auditActionWords(action: string): string {
  return ACCESS_WORDS[action] ?? capabilityWords(action);
}
