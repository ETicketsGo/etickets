/**
 * Organizer acquisition (the sales CRM): the shared vocabulary.
 *
 * One definition of the pipeline, read by the API that enforces it and the console that draws
 * it, so the buttons a person is offered are exactly the moves the server will accept.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────
 * Nothing here sends anything. An "EMAIL" activity is a record that somebody emailed a
 * prospect from their own mailbox; the platform never contacts a prospect. Reports count
 * LOGGED activities and must never present them as messages sent.
 *
 * A lead is not an organizer. Converting one LINKS it to an Organization that already exists
 * (the organizer signed up and went through verification themselves); the CRM never creates,
 * approves or edits an organization.
 */

export const CRM_STAGES = [
  'IDENTIFIED',
  'CONTACTED',
  'RESPONDED_INTERESTED',
  'DEMO_SCHEDULED',
  'DEMO_COMPLETED',
  'NEGOTIATION',
  'ONBOARDING',
  'ACTIVATED',
  'LOST',
] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

/** The forward path, in order. LOST sits outside it. */
export const CRM_PIPELINE: readonly CrmStage[] = CRM_STAGES.filter((s) => s !== 'LOST');

export const CRM_STAGE_LABELS: Record<CrmStage, string> = {
  IDENTIFIED: 'Identified',
  CONTACTED: 'Contacted',
  RESPONDED_INTERESTED: 'Responded, interested',
  DEMO_SCHEDULED: 'Demo scheduled',
  DEMO_COMPLETED: 'Demo completed',
  NEGOTIATION: 'Negotiation',
  ONBOARDING: 'Onboarding',
  ACTIVATED: 'Activated',
  LOST: 'Lost',
};

/**
 * Which stage may follow which.
 *
 * A map rather than "any forward step", so a skipped step is a decision written here. LOST is
 * reachable from everywhere. Leaving LOST is a REOPEN (a manager's decision, with a reason) and
 * only to the start of the pipeline, so a revived deal is worked again rather than parachuted
 * back into negotiation.
 *
 * ACTIVATED appears as a target but is never accepted on a person's word: the server also
 * requires a linked organization that the platform itself has approved.
 */
export const CRM_TRANSITIONS: Record<CrmStage, readonly CrmStage[]> = {
  IDENTIFIED: ['CONTACTED', 'RESPONDED_INTERESTED', 'LOST'],
  CONTACTED: ['RESPONDED_INTERESTED', 'LOST'],
  RESPONDED_INTERESTED: ['DEMO_SCHEDULED', 'NEGOTIATION', 'ONBOARDING', 'LOST'],
  DEMO_SCHEDULED: ['DEMO_COMPLETED', 'RESPONDED_INTERESTED', 'LOST'],
  DEMO_COMPLETED: ['NEGOTIATION', 'ONBOARDING', 'LOST'],
  NEGOTIATION: ['DEMO_SCHEDULED', 'ONBOARDING', 'LOST'],
  ONBOARDING: ['NEGOTIATION', 'ACTIVATED', 'LOST'],
  ACTIVATED: ['LOST'],
  LOST: ['IDENTIFIED', 'CONTACTED'],
};

/** Moving out of LOST. Manager only, with a note. */
export function isReopen(from: CrmStage, to: CrmStage): boolean {
  return from === 'LOST' && to !== 'LOST';
}

export function canTransition(from: CrmStage, to: CrmStage): boolean {
  return CRM_TRANSITIONS[from]?.includes(to) ?? false;
}

export const CRM_ACTIVITY_TYPES = ['EMAIL', 'CALL', 'LINKEDIN', 'MEETING', 'VISIT'] as const;
export type CrmActivityType = (typeof CRM_ACTIVITY_TYPES)[number];

export const CRM_ACTIVITY_LABELS: Record<CrmActivityType, string> = {
  EMAIL: 'Email (logged)',
  CALL: 'Phone call',
  LINKEDIN: 'LinkedIn message (logged)',
  MEETING: 'Meeting',
  VISIT: 'Visit in person',
};

export const CRM_ACTIVITY_OUTCOMES = [
  'NO_RESPONSE',
  'LEFT_MESSAGE',
  'CONNECTED',
  'INTERESTED',
  'NOT_INTERESTED',
  'DEMO_BOOKED',
  'FOLLOW_UP_NEEDED',
  'OTHER',
] as const;
export type CrmActivityOutcome = (typeof CRM_ACTIVITY_OUTCOMES)[number];

export const CRM_OUTCOME_LABELS: Record<CrmActivityOutcome, string> = {
  NO_RESPONSE: 'No response',
  LEFT_MESSAGE: 'Left a message',
  CONNECTED: 'Spoke to them',
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not interested',
  DEMO_BOOKED: 'Demo booked',
  FOLLOW_UP_NEEDED: 'Follow-up needed',
  OTHER: 'Other',
};

export const CRM_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type CrmPriority = (typeof CRM_PRIORITIES)[number];

/**
 * Where a lead came from. Text in the database (not an enum) so a new source is a code change
 * here and not a migration; the API accepts only these.
 */
export const CRM_LEAD_SOURCES = [
  'RESEARCH',
  'REFERRAL',
  'INBOUND',
  'EVENT',
  'LINKEDIN',
  'SOCIAL',
  'PARTNER',
  'COLD_LIST',
  'OTHER',
] as const;
export type CrmLeadSource = (typeof CRM_LEAD_SOURCES)[number];

export const CRM_SOURCE_LABELS: Record<CrmLeadSource, string> = {
  RESEARCH: 'Own research',
  REFERRAL: 'Referral',
  INBOUND: 'They contacted us',
  EVENT: 'Met at an event',
  LINKEDIN: 'LinkedIn',
  SOCIAL: 'Other social media',
  PARTNER: 'Partner',
  COLD_LIST: 'Bought or shared list',
  OTHER: 'Other',
};

/**
 * Countries an acquisition team may work today. A CRM team names one; adding a market is
 * adding its code here and a team row, not a second module.
 */
export const CRM_COUNTRIES = ['IN', 'US'] as const;
export type CrmCountry = (typeof CRM_COUNTRIES)[number];

export const CRM_TEAM_ROLES = ['AGENT', 'MANAGER'] as const;
export type CrmTeamRole = (typeof CRM_TEAM_ROLES)[number];

export const CRM_FOLLOW_UP_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;
export type CrmFollowUpStatus = (typeof CRM_FOLLOW_UP_STATUSES)[number];

/** Bounds the server enforces, shared so the console can say them before a request fails. */
export const CRM_LIMITS = {
  pageSizeMax: 100,
  importRowsMax: 500,
  /** Characters of CSV text in one import request (the API's JSON body limit is 100 kB). */
  importCharsMax: 90_000,
  exportRowsMax: 10_000,
} as const;

/** An organization's status that counts as ACTIVATED: the platform approved it to sell. */
export const CRM_ACTIVATED_ORG_STATUS = 'APPROVED';

/**
 * What the platform's own data says about a linked prospect. Never typed by a person.
 *
 * `activated` is true only while the linked organization's status is APPROVED. The manual
 * stage can say ACTIVATED (it could only be set while this was true) but the dashboards
 * count THIS.
 */
export interface CrmDerivedActivation {
  linked: boolean;
  organization: { id: string; name: string; status: string; createdAt: string } | null;
  activated: boolean;
  firstPublishedEventAt: string | null;
  publishedEventCount: number;
}
