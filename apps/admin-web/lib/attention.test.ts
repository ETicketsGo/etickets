import { describe, expect, it } from 'vitest';
import type { ActionQueue } from '@eticketsgo/web-kit';
import {
  RECONCILIATION_QUEUE,
  attentionQueues,
  failedPaymentsQueue,
  lastSevenDays,
  queueNoun,
  summarise,
  type AttentionItem,
  type QueueOutcome,
} from './attention';

/*
  A stand-in for web-kit's ACTION_QUEUES with the same keys and capabilities, so these tests do
  not load the whole UI kit. The real list is exercised in the browser by the e2e spec.
*/
const q = (key: string, needs: string, tone: ActionQueue['tone'] = 'warning'): ActionQueue => ({
  key,
  needs,
  tone,
  href: `/admin/${key}`,
  consequence: `${key} consequence`,
  label: (n) => `${n} ${n === 1 ? key : `${key}s`}`,
});
const SHARED: ActionQueue[] = [
  q('disputes', 'FINANCE_READ', 'critical'),
  q('refunds-requested', 'REFUND_REVIEW'),
  q('settlements-blocked', 'FINANCE_READ'),
  q('organizers-pending', 'ORGANIZER_REVIEW', 'normal'),
  q('events-review', 'EVENT_REVIEW', 'normal'),
];
const NOW = new Date('2026-10-09T15:00:00.000Z');

describe('which queues an operator is shown', () => {
  it('shows nothing to an account with no duties, rather than everything', () => {
    expect(attentionQueues(SHARED, undefined, NOW)).toEqual([]);
    expect(attentionQueues(SHARED, [], NOW)).toEqual([]);
  });

  it('shows a moderator only moderation queues, and no money', () => {
    const keys = attentionQueues(SHARED, ['ORGANIZER_REVIEW', 'EVENT_REVIEW'], NOW).map(
      (x) => x.key,
    );
    expect(keys).toEqual(['organizers-pending', 'events-review']);
  });

  it('puts reconciliation exceptions right after blocked settlements, for finance only', () => {
    const keys = attentionQueues(SHARED, ['FINANCE_READ'], NOW).map((x) => x.key);
    expect(keys).toEqual(['disputes', 'settlements-blocked', 'reconciliation-open']);
  });

  it('still shows reconciliation if the shared list stops carrying settlements', () => {
    const keys = attentionQueues(
      SHARED.filter((x) => x.key !== 'settlements-blocked'),
      ['FINANCE_READ'],
      NOW,
    ).map((x) => x.key);
    expect(keys).toContain('reconciliation-open');
  });

  it('adds failed payments as INFORMATION, for whoever may read bookings', () => {
    const queues = attentionQueues(SHARED, ['BOOKING_READ'], NOW);
    expect(queues.map((x) => [x.key, x.kind])).toEqual([['payments-failed-7d', 'info']]);
  });

  it('marks every shared queue as action', () => {
    const all = attentionQueues(
      SHARED,
      ['FINANCE_READ', 'REFUND_REVIEW', 'ORGANIZER_REVIEW', 'EVENT_REVIEW'],
      NOW,
    );
    expect(all.every((x) => x.kind === 'action')).toBe(true);
  });
});

describe('every link lands on its filtered list', () => {
  it('opens reconciliation on the exceptions nobody has picked up', () => {
    expect(RECONCILIATION_QUEUE.href).toBe('/admin/finance-reconciliation?status=OPEN');
  });

  it('opens payments on the same seven UTC days the count covers', () => {
    expect(lastSevenDays(NOW)).toEqual({ from: '2026-10-03', to: '2026-10-09' });
    expect(failedPaymentsQueue(NOW).href).toBe(
      '/admin/payments?status=FAILED&from=2026-10-03&to=2026-10-09',
    );
  });

  it('crosses a month boundary', () => {
    expect(lastSevenDays(new Date('2026-03-02T01:00:00.000Z'))).toEqual({
      from: '2026-02-24',
      to: '2026-03-02',
    });
  });
});

describe('sorting the answers', () => {
  const queues = attentionQueues(
    SHARED,
    ['FINANCE_READ', 'REFUND_REVIEW', 'EVENT_REVIEW', 'BOOKING_READ'],
    NOW,
  );
  const items = (outcomes: Record<string, QueueOutcome>): AttentionItem[] =>
    queues.map((queue) => ({ queue, outcome: outcomes[queue.key] ?? { status: 'loading' } }));
  const ok = (count: number): QueueOutcome => ({ status: 'ok', count });

  it('lists only non-empty action queues as needing you, in the fixed order', () => {
    const s = summarise(
      items({
        disputes: ok(1),
        'refunds-requested': ok(40),
        'settlements-blocked': ok(0),
        'reconciliation-open': ok(2),
        'events-review': ok(3),
        'payments-failed-7d': ok(9),
      }),
    );
    // A queue of forty complaints is not more urgent than one chargeback: order never follows size.
    expect(s.needsAction.map((i) => i.queue.key)).toEqual([
      'disputes',
      'refunds-requested',
      'reconciliation-open',
      'events-review',
    ]);
    expect(s.waiting).toBe(46);
    expect(s.clear.map((i) => i.queue.key)).toEqual(['settlements-blocked']);
    expect(s.allChecked).toBe(true);
  });

  it('never counts an informational indicator as work', () => {
    const s = summarise(
      items({
        disputes: ok(0),
        'refunds-requested': ok(0),
        'settlements-blocked': ok(0),
        'reconciliation-open': ok(0),
        'events-review': ok(0),
        'payments-failed-7d': ok(250),
      }),
    );
    expect(s.needsAction).toEqual([]);
    expect(s.waiting).toBe(0);
    expect(s.info.map((i) => i.queue.key)).toEqual(['payments-failed-7d']);
    expect(s.allChecked).toBe(true);
  });

  it('is not "all checked" while a queue is still counting or could not be counted', () => {
    const loading = summarise(items({ disputes: ok(0) }));
    expect(loading.allChecked).toBe(false);
    expect(loading.loading.length).toBeGreaterThan(0);

    const failed = summarise(
      items({
        disputes: { status: 'error' },
        'refunds-requested': ok(0),
        'settlements-blocked': ok(0),
        'reconciliation-open': ok(0),
        'events-review': ok(0),
        'payments-failed-7d': ok(0),
      }),
    );
    expect(failed.allChecked).toBe(false);
    expect(failed.unchecked.map((i) => i.queue.key)).toEqual(['disputes']);
    // An unanswered queue is never listed as clear.
    expect(failed.clear.map((i) => i.queue.key)).not.toContain('disputes');
  });

  it('a failed informational count does not stop the action queues reading as checked', () => {
    const s = summarise(
      items({
        disputes: ok(0),
        'refunds-requested': ok(0),
        'settlements-blocked': ok(0),
        'reconciliation-open': ok(0),
        'events-review': ok(0),
        'payments-failed-7d': { status: 'error' },
      }),
    );
    expect(s.allChecked).toBe(true);
  });
});

describe('queue names', () => {
  it('uses the plural noun with no number', () => {
    expect(queueNoun(RECONCILIATION_QUEUE)).toBe('reconciliation exceptions nobody has picked up');
  });
});
