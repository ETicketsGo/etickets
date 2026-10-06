import { describe, expect, it } from 'vitest';
import { ACTION_QUEUES, queuesFor } from './action-centre';
import { ADMIN_PRESETS, ALL_ADMIN_PERMISSIONS } from '@eticketsgo/shared-types';

describe('the operator action centre', () => {
  it('only ever names capabilities that exist', () => {
    /*
      A queue needing a capability nobody can hold is a queue nobody is ever shown, and it
      fails silently - the page simply renders one item short. `needs: 'FINANCE-READ'` would
      compile and would never appear.
    */
    const known = new Set<string>(ALL_ADMIN_PERMISSIONS);
    const unknown = ACTION_QUEUES.filter((q) => !known.has(q.needs)).map((q) => q.key);
    expect(unknown).toEqual([]);
  });

  it('gives every queue somewhere to go', () => {
    // A count with no destination is a dead end: it tells an operator there is work and not
    // where. Every href has to be a real admin path.
    const bad = ACTION_QUEUES.filter((q) => !q.href.startsWith('/admin/')).map((q) => q.key);
    expect(bad).toEqual([]);
  });

  it('lands on the queue, not on the page that contains it', () => {
    /*
      The point of the whole page. "7 refunds awaiting a decision" linking to an unfiltered
      refund list means the operator arrives and has to find the seven again - which is the
      work the count was supposed to save.

      Two are allowed to carry no filter, for two different reasons, and both are listed here
      rather than skipped so that a THIRD one cannot appear unnoticed:

      - `disputes` needs none. `GET /admin/disputes` returns open chargebacks and nothing else,
        so the whole page is already the queue.
      - `payouts-failed` cannot have one. `GET /admin/payouts` returns every payout in a single
        unpaginated array and the page filters in the browser, so there is no parameter to
        pass. If that endpoint ever learns to filter, this link should carry it.
    */
    const unfiltered = ACTION_QUEUES.filter((q) => !q.href.includes('?')).map((q) => q.key);
    expect(unfiltered).toEqual(['disputes', 'payouts-failed']);
  });

  it('orders by what delay costs, keeping the deadline first', () => {
    // Money lost irrevocably comes before money owed, which comes before somebody blocked
    // from trading. A chargeback has a deadline nobody here can extend, so it leads.
    expect(ACTION_QUEUES[0].key).toBe('disputes');
    expect(ACTION_QUEUES[0].tone).toBe('critical');

    const keys = ACTION_QUEUES.map((q) => q.key);
    expect(keys.indexOf('refunds-failed')).toBeLessThan(keys.indexOf('organizers-pending'));
    expect(keys.indexOf('payouts-failed')).toBeLessThan(keys.indexOf('events-review'));
  });

  it('shows an operator their own queues and nobody else’s', () => {
    const moderator = queuesFor(ADMIN_PRESETS.MODERATOR.grants).map((q) => q.key);
    expect(moderator).toEqual(['organizers-pending', 'events-review']);
    // The thing this is for: moderation is shown no money it cannot act on.
    expect(moderator).not.toContain('disputes');
    expect(moderator).not.toContain('refunds-requested');

    const refundDesk = queuesFor(ADMIN_PRESETS.REFUND_DESK.grants).map((q) => q.key);
    expect(refundDesk).toEqual(['refunds-requested', 'refunds-failed', 'complaints-open']);
    // A refund desk reviews; it does not approve, and it is not shown settlements or payouts.
    expect(refundDesk).not.toContain('payouts-failed');
    expect(refundDesk).not.toContain('settlements-blocked');

    const finance = queuesFor(ADMIN_PRESETS.FINANCE.grants).map((q) => q.key);
    expect(finance).toContain('disputes');
    expect(finance).toContain('payouts-failed');
    expect(finance).toContain('settlements-blocked');
    // Finance is not the moderation desk.
    expect(finance).not.toContain('organizers-pending');

    const support = queuesFor(ADMIN_PRESETS.SUPPORT.grants).map((q) => q.key);
    expect(support).toEqual(['complaints-open']);
  });

  it('keeps the fixed order whatever order the capabilities arrive in', () => {
    // Grants come back from a database and a Set; neither promises an order. If the page
    // took its order from them, the most urgent queue would move around between sessions.
    const forwards = queuesFor(ALL_ADMIN_PERMISSIONS).map((q) => q.key);
    const backwards = queuesFor([...ALL_ADMIN_PERMISSIONS].reverse()).map((q) => q.key);
    expect(backwards).toEqual(forwards);
    expect(forwards).toEqual(ACTION_QUEUES.map((q) => q.key));
  });

  it('shows nothing to an account that has been told nothing', () => {
    /*
      A grantless ADMIN holds no capabilities at all - `permissionsFor` gives a role no
      implicit grants except SUPER_ADMIN - so this is a real state, not a defensive branch.

      It must come back empty rather than fall back to every queue. The caller then has to
      tell the difference between "you hold no duties" and "your queues are empty", because
      answering the first with "nothing is waiting" tells somebody there is no work when what
      is true is that they cannot see any.
    */
    expect(queuesFor([])).toEqual([]);
    expect(queuesFor(undefined)).toEqual([]);
  });

  it('writes counts as English, singular and plural', () => {
    const refunds = ACTION_QUEUES.find((q) => q.key === 'refunds-requested')!;
    expect(refunds.label(1)).toBe('1 refund awaiting a decision');
    expect(refunds.label(4)).toBe('4 refunds awaiting a decision');
  });

  it('says what leaving each queue costs', () => {
    // The consequence is what makes the page scannable: a count says how much, the sentence
    // says why it matters. An empty one would render a bare number with no reason to act.
    for (const q of ACTION_QUEUES) {
      expect(q.consequence.length).toBeGreaterThan(20);
      expect(q.consequence.trim().endsWith('.')).toBe(true);
    }
  });
});
