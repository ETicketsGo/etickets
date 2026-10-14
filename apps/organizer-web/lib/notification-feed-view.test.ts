import { describe, expect, it } from 'vitest';
import type { NotificationFeedGroup } from '@eticketsgo/web-kit';
import {
  affectedLabel,
  filterFeed,
  isStandingProblem,
  relativeTime,
  severityView,
  splitByAttention,
} from './notification-feed-view';

const group = (over: Partial<NotificationFeedGroup>): NotificationFeedGroup => ({
  key: 'k',
  category: 'ACTION_REQUIRED',
  severity: 'CRITICAL',
  type: 'EVENT_NOT_SELLABLE',
  title: 'Telugu Movie - Ticket sales blocked',
  summary: 'Balcony seats need a regulatory seat class. 18 showtimes affected.',
  detail: null,
  ownerNote: null,
  action: null,
  eventId: 'e1',
  notificationIds: ['n1'],
  unreadIds: ['n1'],
  read: false,
  firstAt: '2026-10-01T00:00:00.000Z',
  lastAt: '2026-10-01T00:00:00.000Z',
  sessions: [],
  affectedSessions: 18,
  resolved: null,
  dismissible: false,
  ...over,
});

describe('what a section shows straight away', () => {
  it('keeps a standing problem in view after it has been read', () => {
    const read = group({ read: true, unreadIds: [] });
    expect(splitByAttention([read]).shown).toEqual([read]);
  });

  it('puts away a fixed problem once read, and read information', () => {
    const fixed = group({ key: 'a', read: true, resolved: true, unreadIds: [] });
    const info = group({ key: 'b', category: 'EVENT_APPROVALS', read: true, unreadIds: [] });
    const fresh = group({ key: 'c', category: 'EVENT_APPROVALS' });
    const { shown, earlier } = splitByAttention([fixed, info, fresh]);
    expect(shown.map((g) => g.key)).toEqual(['c']);
    expect(earlier.map((g) => g.key)).toEqual(['a', 'b']);
  });
});

describe('severity', () => {
  it('names severity in words, and says a fixed problem is fixed', () => {
    expect(severityView(group({})).label).toBe('Needs action');
    expect(severityView(group({ severity: 'SUCCESS', resolved: true })).label).toBe('Fixed');
  });
});

describe('relative time', () => {
  const now = new Date('2026-10-09T12:00:00.000Z');
  it.each([
    ['2026-10-09T11:59:30.000Z', 'just now'],
    ['2026-10-09T11:59:00.000Z', '1 minute ago'],
    ['2026-10-09T11:15:00.000Z', '45 minutes ago'],
    ['2026-10-09T09:00:00.000Z', '3 hours ago'],
    ['2026-10-08T10:00:00.000Z', 'yesterday'],
    ['2026-10-05T12:00:00.000Z', '4 days ago'],
    ['2026-09-25T12:00:00.000Z', '2 weeks ago'],
    ['2026-07-01T12:00:00.000Z', '1 Jul 2026'],
  ])('%s reads as %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe('affected count', () => {
  it('says nothing when the card is not about shows', () => {
    expect(affectedLabel(0)).toBeNull();
    expect(affectedLabel(1)).toBe('1 showtime affected');
    expect(affectedLabel(18)).toBe('18 showtimes affected');
  });
});

describe('narrowing the list', () => {
  const problem = group({ key: 'p' });
  const readApproval = group({
    key: 'r',
    category: 'EVENT_APPROVALS',
    severity: 'SUCCESS',
    read: true,
    unreadIds: [],
  });
  const newApproval = group({ key: 'n', category: 'EVENT_APPROVALS', severity: 'SUCCESS' });
  const sections = [
    { category: 'ACTION_REQUIRED' as const, label: 'Action required', groups: [problem] },
    {
      category: 'EVENT_APPROVALS' as const,
      label: 'Event approvals',
      groups: [readApproval, newApproval],
    },
    { category: 'SYSTEM_UPDATES' as const, label: 'System updates', groups: [] },
  ];

  it('All keeps the server order and drops empty subjects', () => {
    expect(filterFeed(sections, 'all').map((s) => s.category)).toEqual([
      'ACTION_REQUIRED',
      'EVENT_APPROVALS',
    ]);
  });

  it('Unread keeps only unread rows, and their subjects', () => {
    const out = filterFeed(sections, 'unread');
    expect(out.map((s) => s.groups.map((g) => g.key))).toEqual([['p'], ['n']]);
  });

  it('a subject filter shows that subject alone', () => {
    expect(filterFeed(sections, 'EVENT_APPROVALS').map((s) => s.category)).toEqual([
      'EVENT_APPROVALS',
    ]);
    expect(filterFeed(sections, 'SYSTEM_UPDATES')).toEqual([]);
  });

  it('a standing problem is one not known to be fixed', () => {
    expect(isStandingProblem(problem)).toBe(true);
    expect(isStandingProblem(group({ resolved: true }))).toBe(false);
    expect(isStandingProblem(newApproval)).toBe(false);
  });
});
