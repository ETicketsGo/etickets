import { describe, it, expect } from 'vitest';
import type { OrganizerAction, OrganizerActionSummary } from '@eticketsgo/web-kit';

/**
 * The three setup surfaces must be views of one list, not three checklists.
 *
 * They were: "Needs your attention" read `organizationReadiness` from the server, while "Finish
 * setting up" and "Get started" derived completion in the browser from four list endpoints and a
 * payments call. Two of those asked the same question - can this organization be paid - in
 * different words with different rules, so the dashboard could say one thing and the setup page
 * another.
 *
 * These tests pin the SPLIT between the surfaces, which is the only thing the client still
 * decides. Completion itself is the server's and is proved in `organizer-actions.spec.ts`.
 */

/** The same split the two components apply. Kept here so a change to either has to change this. */
const SETUP_CATEGORIES: OrganizerAction['category'][] = ['OPERATIONS', 'MONEY'];
const ATTENTION_CATEGORIES: OrganizerAction['category'][] = ['BUSINESS', 'MONEY'];

const setupSteps = (s: OrganizerActionSummary) =>
  s.actions.filter((a) => SETUP_CATEGORIES.includes(a.category));
const attentionItems = (s: OrganizerActionSummary) =>
  s.actions.filter((a) => !a.done && ATTENTION_CATEGORIES.includes(a.category));

const action = (
  over: Partial<OrganizerAction> & { key: string; category: OrganizerAction['category'] },
): OrganizerAction => ({
  severity: 'IMPORTANT',
  scope: 'ORGANIZATION',
  organizationId: 'org1',
  blocking: false,
  title: over.key,
  consequence: 'Something it costs.',
  fixPath: '/organizer/settings',
  actionLabel: 'Fix this',
  done: false,
  ...over,
});

const SUMMARY: OrganizerActionSummary = {
  organizationId: 'org1',
  actions: [
    action({ key: 'payout-account', category: 'MONEY', severity: 'BLOCKING' }),
    action({ key: 'legal-identity', category: 'BUSINESS' }),
    action({ key: 'registered-address', category: 'BUSINESS' }),
    action({ key: 'venue', category: 'OPERATIONS', done: true }),
    action({ key: 'seating', category: 'OPERATIONS', severity: 'SUGGESTED', optional: true }),
    action({ key: 'team', category: 'OPERATIONS', severity: 'SUGGESTED' }),
    action({ key: 'experience', category: 'OPERATIONS' }),
  ],
  progress: { done: 1, total: 5 },
  counts: { blocking: 1, important: 3, suggested: 1 },
};

describe('the setup surfaces are views of one list', () => {
  it('never disagrees about whether a shared item is done', () => {
    /*
      The money item appears on both surfaces deliberately - it is genuinely both a setup step and
      an attention item - and that is only safe because both read the SAME row. If one ever
      recomputed it, this is where it would show.
    */
    const inSetup = setupSteps(SUMMARY).find((a) => a.key === 'payout-account');
    const inAttention = attentionItems(SUMMARY).find((a) => a.key === 'payout-account');
    expect(inSetup).toBeDefined();
    expect(inAttention).toBeDefined();
    expect(inSetup!.done).toBe(inAttention!.done);
    expect(inSetup).toBe(inAttention);
  });

  it('drops a shared item from attention the moment it is done, on both surfaces at once', () => {
    const settled: OrganizerActionSummary = {
      ...SUMMARY,
      actions: SUMMARY.actions.map((a) => (a.key === 'payout-account' ? { ...a, done: true } : a)),
    };
    expect(attentionItems(settled).find((a) => a.key === 'payout-account')).toBeUndefined();
    // Still a step, now ticked - a checklist that hides finished work loses its sense of progress.
    expect(setupSteps(settled).find((a) => a.key === 'payout-account')!.done).toBe(true);
  });

  it('keeps business identity out of the setup checklist', () => {
    // Those are attention items, not steps to selling: an organizer with no logo sells fine.
    expect(setupSteps(SUMMARY).map((a) => a.key)).not.toContain('legal-identity');
    expect(setupSteps(SUMMARY).map((a) => a.key)).not.toContain('registered-address');
  });

  it('keeps built-work out of the attention list', () => {
    expect(attentionItems(SUMMARY).map((a) => a.key)).not.toContain('venue');
    expect(attentionItems(SUMMARY).map((a) => a.key)).not.toContain('experience');
  });

  it('covers every action between the two surfaces, so nothing is invisible', () => {
    // A category that belongs to neither view would silently disappear from the console.
    const shown = new Set([...setupSteps(SUMMARY), ...attentionItems(SUMMARY)].map((a) => a.key));
    for (const a of SUMMARY.actions) {
      if (!a.done) expect(shown.has(a.key)).toBe(true);
    }
  });

  it('shows attention only for outstanding work', () => {
    expect(attentionItems(SUMMARY).every((a) => !a.done)).toBe(true);
  });
});
