import { api } from '@eticketsgo/web-kit';
import {
  saleStateLabel,
  type EventSaleState,
  type SaleReason,
  type SaleStateKind,
} from '@eticketsgo/shared-types';

/**
 * The server's unified sale state, put into the console's words - for every organizer screen.
 *
 * ── WHY ONE FILE ──────────────────────────────────────────────────────────────────
 * QA, 2026-10-10: one Vijayawada show read "Not selling: 1 problem to fix" on the Overview and
 * "Selling" in the cinema drawer while checkout sold part of it. Each screen had its own rules.
 * The API now decides once (`sale-state.ts` in shared-types, from the facts checkout reads), and
 * this only says the answer: "Selling" | "Partly selling: <reason>" | "Not selling: <reason>".
 * A PARTIAL answer is never bare "Selling"; no answer is never "Selling" either.
 */

export type SaleTone = 'success' | 'info' | 'warning' | 'neutral';

export interface SaleView {
  /** The server's state; null while unanswered or unreadable. */
  state: SaleStateKind | null;
  /** True only for SELLING. */
  selling: boolean;
  label: string;
  tone: SaleTone;
  /** The server's full sentence for the lead reason. */
  detail: string | null;
  /** Where the organizer fixes the lead reason, when it is theirs to fix. */
  fixPath: string | null;
}

/**
 * Reasons that are where the event is in its life, not something wrong with it. A draft is
 * "Not selling" as a plain fact; amber is kept for a published event that should sell and
 * does not.
 */
const LIFECYCLE = new Set<string>([
  'EVENT_NOT_PUBLISHED',
  'NO_UPCOMING_SESSIONS',
  'SESSION_ENDED',
  'SESSION_STARTED',
  'SESSION_CANCELLED',
]);

export function saleTone(answer: Pick<EventSaleState, 'state' | 'reasons'>): SaleTone {
  if (answer.state === 'SELLING') return 'success';
  if (answer.state === 'PARTIAL') return 'info';
  const lead: SaleReason | undefined = answer.reasons[0];
  return lead && LIFECYCLE.has(lead.code) ? 'neutral' : 'warning';
}

/** While loading, the label the cinema chip already spins for. */
export const CHECKING_LABEL = 'Checking sale status';

export function saleViewOf(
  answer: Pick<EventSaleState, 'state' | 'reasons'> | undefined,
  opts: { failed?: boolean } = {},
): SaleView {
  if (!answer)
    return {
      state: null,
      selling: false,
      label: opts.failed ? 'Sale status unavailable' : CHECKING_LABEL,
      tone: 'neutral',
      detail: null,
      fixPath: null,
    };
  const lead = answer.state === 'SELLING' ? undefined : answer.reasons[0];
  return {
    state: answer.state,
    selling: answer.state === 'SELLING',
    label: saleStateLabel(answer),
    tone: saleTone(answer),
    detail: lead?.message ?? null,
    fixPath: lead && lead.owner === 'ORGANIZER' ? lead.fixPath : null,
  };
}

/** The server takes at most this many ids per request. */
export const SALE_STATE_BATCH = 50;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Every event's state, in as many requests of 50 as the list needs. */
export async function eventSaleStates(organizationId: string, eventIds: string[]) {
  const ids = [...new Set(eventIds)];
  const pages = await Promise.all(
    chunks(ids, SALE_STATE_BATCH).map((part) => api.events.saleStates(organizationId, part)),
  );
  return pages.flatMap((p) => p.events);
}

/** Every show's state, in as many requests of 50 as the list needs. */
export async function sessionSaleStates(organizationId: string, sessionIds: string[]) {
  const ids = [...new Set(sessionIds)];
  const pages = await Promise.all(
    chunks(ids, SALE_STATE_BATCH).map((part) => api.events.saleEligibility(organizationId, part)),
  );
  return pages.flatMap((p) => p.sessions);
}
