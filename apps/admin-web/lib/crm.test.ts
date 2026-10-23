import { describe, expect, it } from 'vitest';
import { visibleNav } from '@eticketsgo/web-kit';
import { adminNavItems, ADMIN_NAV } from './admin-nav';
import {
  crmAccess,
  dayEndExclusiveIso,
  dayStartIso,
  followUpState,
  fromLocalInput,
  LOGGED_NOT_SENT,
  nextActionText,
  percentOf,
  ratioText,
  stageLabel,
  wholeDays,
} from './crm';

const NOW = new Date('2026-10-23T12:00:00Z');
const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

describe('acquisition metrics in words', () => {
  it('always says what a percentage is a share of', () => {
    expect(ratioText({ numerator: 12, denominator: 40 })).toBe('12 of 40 (30%)');
    expect(ratioText({ numerator: 1, denominator: 3 }, 'leads')).toBe('1 of 3 leads (33%)');
    expect(ratioText({ numerator: 1200, denominator: 4000 })).toBe('1,200 of 4,000 (30%)');
  });

  it('never prints 0% of nothing', () => {
    expect(percentOf({ numerator: 0, denominator: 0 })).toBeNull();
    expect(ratioText({ numerator: 0, denominator: 0 })).toBe('0 of 0 (no data yet)');
    expect(ratioText({ numerator: 0, denominator: 5 })).toBe('0 of 5 (0%)');
  });

  it('names stages the way people say them', () => {
    expect(stageLabel('RESPONDED_INTERESTED')).toBe('Responded, interested');
    expect(stageLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('keeps every line ASCII', () => {
    expect(LOGGED_NOT_SENT).toMatch(/^[\x20-\x7e]+$/);
    expect(ratioText({ numerator: 3, denominator: 9 })).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('the next action on a lead', () => {
  it('reads overdue, soon, later and none', () => {
    expect(followUpState(null, NOW)).toBe('none');
    expect(followUpState(at(-1), NOW)).toBe('overdue');
    expect(followUpState(at(5), NOW)).toBe('soon');
    expect(followUpState(at(72), NOW)).toBe('later');
    expect(nextActionText({ nextFollowUpAt: at(-50), stage: 'CONTACTED' }, NOW)).toBe(
      'Follow-up overdue by 2 days',
    );
    expect(nextActionText({ nextFollowUpAt: at(-2), stage: 'CONTACTED' }, NOW)).toBe(
      'Follow-up overdue (today)',
    );
    expect(nextActionText({ nextFollowUpAt: at(72), stage: 'CONTACTED' }, NOW)).toBe(
      'Follow-up in 3 days',
    );
    expect(nextActionText({ nextFollowUpAt: null, stage: 'IDENTIFIED' }, NOW)).toBe(
      'No follow-up set',
    );
    expect(nextActionText({ nextFollowUpAt: at(-5), stage: 'LOST' }, NOW)).toBe('Lost. No action.');
  });

  it('counts whole days, never negative', () => {
    expect(wholeDays(at(-49), NOW)).toBe(2);
    expect(wholeDays(at(5), NOW)).toBe(0);
  });
});

describe('report date filters', () => {
  it('makes "to" include the whole of its day', () => {
    expect(dayStartIso('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
    expect(dayEndExclusiveIso('2026-10-23')).toBe('2026-10-24T00:00:00.000Z');
    expect(dayStartIso('')).toBeUndefined();
    expect(fromLocalInput('')).toBeUndefined();
    expect(fromLocalInput('nonsense')).toBeUndefined();
  });
});

describe('the Organizer Acquisition menu', () => {
  const group = ADMIN_NAV.find((g) => g.key === 'acquisition')!;
  const who = (adminPermissions: string[], roles = ['ADMIN']) => ({ roles, adminPermissions });
  const hrefs = (user: { roles: string[]; adminPermissions: string[] }) =>
    visibleNav(adminNavItems(), user).map((i) => i.href);

  it('has the seven pages, in working order', () => {
    expect(group.label).toBe('Organizer Acquisition');
    expect(group.links.map((l) => l.label)).toEqual([
      'Overview',
      'Prospects',
      'Pipeline',
      'Follow-ups',
      'Activities',
      'Team Performance',
      'Reports',
    ]);
  });

  it('is hidden from staff without a CRM duty', () => {
    const shown = hrefs(who(['BOOKING_READ', 'FINANCE_READ']));
    expect(shown.filter((h) => h.startsWith('/admin/acquisition'))).toEqual([]);
  });

  it('shows an agent their working pages but not the manager ones', () => {
    const shown = hrefs(who(['CRM_AGENT'])).filter((h) => h.startsWith('/admin/acquisition'));
    expect(shown).toEqual([
      '/admin/acquisition',
      '/admin/acquisition/prospects',
      '/admin/acquisition/pipeline',
      '/admin/acquisition/follow-ups',
      '/admin/acquisition/activities',
    ]);
  });

  it('gives an agent nothing else in the console', () => {
    const shown = hrefs(who(['CRM_AGENT']));
    // Only the CRM, plus the pages every operator has (dashboard, own account security).
    expect(shown.filter((h) => !h.startsWith('/admin/acquisition'))).toEqual([
      '/admin',
      '/admin/security',
    ]);
  });

  it('shows a manager every acquisition page', () => {
    const shown = hrefs(who(['CRM_AGENT', 'CRM_MANAGER'])).filter((h) =>
      h.startsWith('/admin/acquisition'),
    );
    expect(shown).toHaveLength(7);
  });

  it('agrees with the page-level access check', () => {
    expect(crmAccess({ adminPermissions: ['CRM_AGENT'] })).toEqual({ agent: true, manager: false });
    // The API needs both for manager routes; so does the console.
    expect(crmAccess({ adminPermissions: ['CRM_MANAGER'] })).toEqual({
      agent: false,
      manager: false,
    });
    expect(crmAccess(null)).toEqual({ agent: false, manager: false });
  });
});
