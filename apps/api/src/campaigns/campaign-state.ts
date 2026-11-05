/**
 * The campaign lifecycle, as one pure function.
 *
 * ── WHY PURE ───────────────────────────────────────────────────────────────────────
 * The API (organizer actions), the admin console (pause) and the worker (promote, start,
 * finish) all move a campaign. If each wrote its own `if (status === ...)`, one of them would
 * eventually let a cancelled campaign start sending. So every move asks `transition`, and the
 * table below is tested row by row with no database.
 *
 *   DRAFT ──schedule──> SCHEDULED ──promote (due)──> QUEUED ──start──> SENDING ──finish──> COMPLETED
 *     │                    │                           │                 │                PARTIALLY_FAILED
 *     └──sendNow───────────┴──sendNow──────────────────┘                 │                FAILED
 *                                                                        │
 *   QUEUED / SENDING ──pause──> PAUSED ──resume──> QUEUED                │
 *   DRAFT / SCHEDULED / PENDING_APPROVAL / QUEUED / PAUSED ──cancel──> CANCELLED
 *
 * A SENDING campaign cannot be cancelled in one step: pause it first. That way "cancel" always
 * means "nothing more goes out", and a person sees the pause take effect before deciding.
 *
 * PENDING_APPROVAL is in the table for a platform review step (submit -> approve / reject).
 * Nothing in this change requires approval; the states exist so adding it later is a config
 * change, not a migration.
 */

export const CampaignStatus = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  PARTIALLY_FAILED: 'PARTIALLY_FAILED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type CampaignStatus = (typeof CampaignStatus)[keyof typeof CampaignStatus];

export const CampaignAction = {
  /** Change the content, audience or settings. */
  EDIT: 'EDIT',
  SCHEDULE: 'SCHEDULE',
  RESCHEDULE: 'RESCHEDULE',
  /** Take a scheduled campaign back to a draft, so it can be edited. */
  UNSCHEDULE: 'UNSCHEDULE',
  SUBMIT_FOR_APPROVAL: 'SUBMIT_FOR_APPROVAL',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  SEND_NOW: 'SEND_NOW',
  /** System: a scheduled campaign is due. */
  PROMOTE: 'PROMOTE',
  /** System: the recipients are materialised and sending begins. */
  START: 'START',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  CANCEL: 'CANCEL',
  /** System: every recipient is final. The outcome decides which final status. */
  FINISH: 'FINISH',
  /** System: the campaign cannot be sent at all (for example the sending config is refused). */
  FAIL: 'FAIL',
} as const;
export type CampaignAction = (typeof CampaignAction)[keyof typeof CampaignAction];

export const FINAL_STATUSES: readonly CampaignStatus[] = [
  CampaignStatus.COMPLETED,
  CampaignStatus.PARTIALLY_FAILED,
  CampaignStatus.FAILED,
  CampaignStatus.CANCELLED,
];

/** States in which the worker may send. Anything else makes an in-flight job a no-op. */
export const DISPATCHING_STATUSES: readonly CampaignStatus[] = [CampaignStatus.SENDING];

export function isFinal(status: CampaignStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

/** Every allowed move. Absent means refused. FINISH is resolved by `finishStatus`. */
const TABLE: Record<CampaignStatus, Partial<Record<CampaignAction, CampaignStatus | 'FINISH'>>> = {
  DRAFT: {
    EDIT: 'DRAFT',
    SCHEDULE: 'SCHEDULED',
    SUBMIT_FOR_APPROVAL: 'PENDING_APPROVAL',
    SEND_NOW: 'QUEUED',
    CANCEL: 'CANCELLED',
  },
  SCHEDULED: {
    RESCHEDULE: 'SCHEDULED',
    UNSCHEDULE: 'DRAFT',
    SEND_NOW: 'QUEUED',
    PROMOTE: 'QUEUED',
    CANCEL: 'CANCELLED',
  },
  PENDING_APPROVAL: {
    APPROVE: 'SCHEDULED',
    REJECT: 'DRAFT',
    CANCEL: 'CANCELLED',
  },
  QUEUED: {
    START: 'SENDING',
    PAUSE: 'PAUSED',
    CANCEL: 'CANCELLED',
    FAIL: 'FAILED',
  },
  SENDING: {
    PAUSE: 'PAUSED',
    FINISH: 'FINISH',
    FAIL: 'FAILED',
  },
  PAUSED: {
    RESUME: 'QUEUED',
    CANCEL: 'CANCELLED',
  },
  COMPLETED: {},
  PARTIALLY_FAILED: {},
  FAILED: {},
  CANCELLED: {},
};

/** Recipient counts by status, as the worker reads them. Missing keys are zero. */
export type RecipientCounts = Partial<Record<RecipientStatus, number>>;

export const RecipientStatus = {
  PENDING: 'PENDING',
  SKIPPED_CONSENT: 'SKIPPED_CONSENT',
  SKIPPED_SUPPRESSED: 'SKIPPED_SUPPRESSED',
  QUEUED: 'QUEUED',
  ACCEPTED: 'ACCEPTED',
  DELIVERED: 'DELIVERED',
  DEFERRED: 'DEFERRED',
  BOUNCED: 'BOUNCED',
  COMPLAINED: 'COMPLAINED',
  FAILED: 'FAILED',
  UNSUBSCRIBED: 'UNSUBSCRIBED',
} as const;
export type RecipientStatus = (typeof RecipientStatus)[keyof typeof RecipientStatus];

/** Not yet decided: the worker still owes these a send attempt. */
export const OPEN_RECIPIENT_STATUSES: readonly RecipientStatus[] = ['PENDING', 'QUEUED'];

/** The provider took the message. What happened next (delivered, bounced) is the provider's. */
export const ACCEPTED_RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'ACCEPTED',
  'DELIVERED',
  'DEFERRED',
  'BOUNCED',
  'COMPLAINED',
  'UNSUBSCRIBED',
];

/**
 * The final status of a campaign whose recipients are all decided.
 *
 *   - nothing failed                       -> COMPLETED (an all-skipped audience included:
 *                                             the campaign did exactly what it should)
 *   - some accepted, some failed           -> PARTIALLY_FAILED
 *   - nothing accepted and something failed -> FAILED
 *
 * Bounces and complaints are NOT failures of the send: the provider accepted the message and
 * the address answered. They are reported in the stats, not in the status.
 */
export function finishStatus(counts: RecipientCounts): CampaignStatus {
  const n = (s: RecipientStatus) => counts[s] ?? 0;
  const accepted = ACCEPTED_RECIPIENT_STATUSES.reduce((sum, s) => sum + n(s), 0);
  const failed = n('FAILED');
  if (failed === 0) return CampaignStatus.COMPLETED;
  if (accepted === 0) return CampaignStatus.FAILED;
  return CampaignStatus.PARTIALLY_FAILED;
}

/** Whether any recipient still needs a send attempt. */
export function hasOpenRecipients(counts: RecipientCounts): boolean {
  return OPEN_RECIPIENT_STATUSES.some((s) => (counts[s] ?? 0) > 0);
}

export type TransitionResult = { ok: true; to: CampaignStatus } | { ok: false; reason: string };

/**
 * The status after `action`, or why it is refused.
 *
 * FINISH needs the recipient counts, and is refused while any recipient is still open, so a
 * campaign can never be marked done with mail still owed.
 */
export function transition(
  from: CampaignStatus,
  action: CampaignAction,
  counts?: RecipientCounts,
): TransitionResult {
  const target = TABLE[from]?.[action];
  if (!target) {
    return { ok: false, reason: refusal(from, action) };
  }
  if (target === 'FINISH') {
    if (!counts) return { ok: false, reason: 'Finishing a campaign needs its recipient counts.' };
    if (hasOpenRecipients(counts)) {
      return { ok: false, reason: 'Some recipients have not been sent to yet.' };
    }
    return { ok: true, to: finishStatus(counts) };
  }
  return { ok: true, to: target };
}

/** Plain words for a person, never a status code alone. */
function refusal(from: CampaignStatus, action: CampaignAction): string {
  if (isFinal(from)) return 'This campaign has finished. Duplicate it to send it again.';
  if (action === CampaignAction.EDIT) {
    return from === CampaignStatus.SCHEDULED
      ? 'This campaign is scheduled. Move it back to draft to edit it.'
      : 'Only a draft can be edited.';
  }
  if (action === CampaignAction.CANCEL && from === CampaignStatus.SENDING) {
    return 'This campaign is sending. Pause it first, then cancel it.';
  }
  if (action === CampaignAction.PAUSE) return 'Only a campaign that is sending can be paused.';
  if (action === CampaignAction.RESUME) return 'Only a paused campaign can be resumed.';
  if (action === CampaignAction.RESCHEDULE) return 'Only a scheduled campaign can be rescheduled.';
  return `This campaign cannot do that now (it is ${from.toLowerCase().replace(/_/g, ' ')}).`;
}
