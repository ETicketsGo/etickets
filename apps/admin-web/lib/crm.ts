import {
  CRM_ACTIVITY_LABELS,
  CRM_OUTCOME_LABELS,
  CRM_SOURCE_LABELS,
  CRM_STAGE_LABELS,
  type CrmStage,
} from '@eticketsgo/shared-types';
import { holds } from './capabilities';

/**
 * Words and numbers for the Organizer Acquisition pages. Pure, so the rules that keep the
 * dashboards honest are tested on their own (`crm.test.ts`). All copy is plain ASCII.
 */

export interface Ratio {
  numerator: number;
  denominator: number;
}

/** A share as a whole percent, or null when there is nothing to take a share of. */
export function percentOf(r: Ratio): number | null {
  if (!r || r.denominator <= 0) return null;
  return Math.round((r.numerator / r.denominator) * 100);
}

/**
 * "12 of 40 (30%)". Never a bare percentage: the reader always sees what it is a share OF.
 * With nothing to divide by it says so, rather than printing 0%.
 */
export function ratioText(r: Ratio, of?: string): string {
  const pct = percentOf(r);
  const tail = of ? ` ${of}` : '';
  if (pct === null) return `0 of 0${tail} (no data yet)`;
  return `${r.numerator.toLocaleString('en-US')} of ${r.denominator.toLocaleString('en-US')}${tail} (${pct}%)`;
}

export function stageLabel(stage: string): string {
  return CRM_STAGE_LABELS[stage as CrmStage] ?? stage;
}

export function sourceLabel(source: string): string {
  return (CRM_SOURCE_LABELS as Record<string, string>)[source] ?? source;
}

export function activityLabel(type: string): string {
  return (CRM_ACTIVITY_LABELS as Record<string, string>)[type] ?? type;
}

export function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return '';
  return (CRM_OUTCOME_LABELS as Record<string, string>)[outcome] ?? outcome;
}

export function countryName(code: string | null | undefined): string {
  if (code === 'IN') return 'India';
  if (code === 'US') return 'USA';
  return code ?? '';
}

/** Badge tone for a stage. */
export function stageTone(stage: string): 'neutral' | 'info' | 'warning' | 'success' | 'error' {
  if (stage === 'LOST') return 'error';
  if (stage === 'ACTIVATED') return 'success';
  if (stage === 'ONBOARDING' || stage === 'NEGOTIATION') return 'warning';
  if (stage === 'IDENTIFIED') return 'neutral';
  return 'info';
}

const DAY = 86_400_000;

/** Whole days between two instants, never negative. */
export function wholeDays(from: string | Date, to: Date = new Date()): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / DAY));
}

export type FollowUpState = 'none' | 'overdue' | 'soon' | 'later';

export function followUpState(
  dueAt: string | null | undefined,
  now: Date = new Date(),
): FollowUpState {
  if (!dueAt) return 'none';
  const t = new Date(dueAt).getTime();
  if (t < now.getTime()) return 'overdue';
  if (t < now.getTime() + DAY) return 'soon';
  return 'later';
}

/** The "next action" line a list row shows, so nobody has to open a lead to know. */
export function nextActionText(
  lead: { nextFollowUpAt: string | null; stage: string },
  now: Date = new Date(),
): string {
  if (lead.stage === 'LOST') return 'Lost. No action.';
  if (lead.stage === 'ACTIVATED') return 'Activated. No action.';
  const state = followUpState(lead.nextFollowUpAt, now);
  if (state === 'none') return 'No follow-up set';
  const due = new Date(lead.nextFollowUpAt as string);
  if (state === 'overdue') {
    const days = wholeDays(due, now);
    return days === 0 ? 'Follow-up overdue (today)' : `Follow-up overdue by ${plural(days, 'day')}`;
  }
  if (state === 'soon') return 'Follow-up due in the next 24 hours';
  const days = Math.ceil((due.getTime() - now.getTime()) / DAY);
  return `Follow-up in ${plural(days, 'day')}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What the signed-in operator may do in Organizer Acquisition. Mirrors the API guard. */
export function crmAccess(user: { adminPermissions?: readonly string[] } | null | undefined) {
  return {
    agent: holds(user, 'CRM_AGENT'),
    manager: holds(user, 'CRM_AGENT') && holds(user, 'CRM_MANAGER'),
  };
}

/** Shown instead of an acquisition page to somebody without the duty. ASCII only. */
export const NO_CRM_ACCESS =
  'You do not have access to Organizer Acquisition. It needs the Acquisition agent duty.';
export const NO_CRM_MANAGER_ACCESS =
  'This page is for acquisition managers. It needs the Acquisition manager duty.';

/** Said wherever logged outreach is listed or counted. */
export const LOGGED_NOT_SENT =
  'These are activities your team logged. ETicketsGo did not send any email, SMS or message.';

/** A `datetime-local` input value for an instant, in the browser's own zone. */
export function toLocalInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A `datetime-local` value back to an ISO instant, or undefined when empty or invalid. */
export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** A `date` input (YYYY-MM-DD) as the start of that day, UTC, for a report filter. */
export function dayStartIso(day: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : undefined;
}

/** The day AFTER a `date` input, so "to 23 Oct" includes all of the 23rd. */
export function dayEndExclusiveIso(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00.000Z`);
  return new Date(d.getTime() + DAY).toISOString();
}
