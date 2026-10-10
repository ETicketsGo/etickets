import { describe, expect, it } from 'vitest';
import {
  activeSectionIndex,
  filterQuickNav,
  navAllowed,
  navCurrentHref,
  navInSection,
  navSections,
  quickNavEntries,
  visibleNav,
  type NavItem,
} from './nav';

const NAV: NavItem[] = [
  {
    label: 'Overview',
    href: '/organizer',
    exact: true,
    children: [{ label: 'Get started', href: '/organizer/onboarding' }],
  },
  { label: 'Venues & seating', href: '/organizer/venues', match: ['/organizer/cinemas'] },
  {
    label: 'Finance & payouts',
    href: '/organizer/finance',
    children: [{ label: 'Payouts', href: '/organizer/payouts' }],
  },
];

describe('which nav item is the current page', () => {
  it('marks a secondary page itself, not the section above it', () => {
    expect(navCurrentHref('/organizer/payouts', NAV)).toBe('/organizer/payouts');
  });

  it('marks the section for a page under an extra prefix', () => {
    expect(navCurrentHref('/organizer/cinemas/abc/schedule', NAV)).toBe('/organizer/venues');
  });

  it('does not mark Overview for every organizer page, because it is exact', () => {
    expect(navCurrentHref('/organizer/finance', NAV)).toBe('/organizer/finance');
    expect(navCurrentHref('/organizer', NAV)).toBe('/organizer');
  });

  it('marks nothing for a page the nav does not know', () => {
    expect(navCurrentHref('/organizer/somewhere-else', NAV)).toBeNull();
  });

  it('a prefix match is a path segment, not a string prefix', () => {
    // "/organizer/venues-archive" is not inside "/organizer/venues".
    expect(navCurrentHref('/organizer/venues-archive', NAV)).toBeNull();
  });
});

describe('which section is open', () => {
  it('opens a section when one of its children is the page', () => {
    expect(navInSection('/organizer/onboarding', NAV[0])).toBe(true);
    expect(navInSection('/organizer/payouts', NAV[2])).toBe(true);
  });

  it('leaves the others closed', () => {
    expect(navInSection('/organizer/payouts', NAV[0])).toBe(false);
    expect(navInSection('/organizer/payouts', NAV[1])).toBe(false);
  });
});

describe('who may see an item', () => {
  const item: NavItem = {
    label: 'Payouts',
    href: '/admin/payouts',
    capabilities: ['PAYOUT_MANAGE'],
  };

  it('needs every listed capability, like the API guard', () => {
    expect(navAllowed(item, { roles: ['ADMIN'], adminPermissions: ['PAYOUT_MANAGE'] })).toBe(true);
    expect(navAllowed(item, { roles: ['ADMIN'], adminPermissions: ['FINANCE_READ'] })).toBe(false);
    expect(
      navAllowed({ ...item, capabilities: ['A', 'B'] }, { roles: [], adminPermissions: ['A'] }),
    ).toBe(false);
  });

  it('hides a capability-gated item while the viewer is unknown', () => {
    expect(navAllowed(item, null)).toBe(false);
    expect(navAllowed({ label: 'Help', href: '/help' }, null)).toBe(true);
  });

  it('removes forbidden children and keeps the parent', () => {
    const nav: NavItem[] = [
      {
        label: 'Finance',
        href: '/f',
        group: 'Business',
        children: [{ label: 'Payouts', href: '/f/p', roles: ['OWNER'] }],
      },
    ];
    const out = visibleNav(nav, { roles: ['STAFF'] });
    expect(out[0].children).toBeUndefined();
    expect(out[0].group).toBe('Business');
  });
});

describe('groups', () => {
  const nav: NavItem[] = [
    { label: 'Overview', href: '/o', exact: true, group: 'Workspace' },
    { label: 'Events', href: '/o/events' },
    {
      label: 'Finance',
      href: '/o/finance',
      group: 'Business',
      children: [{ label: 'Payouts', href: '/o/payouts' }],
    },
  ];

  it('opens the group holding the current page, including a child page', () => {
    const sections = navSections(nav);
    expect(sections.map((s) => s.label)).toEqual(['Workspace', 'Business']);
    expect(activeSectionIndex('/o/events/123', sections)).toBe(0);
    expect(activeSectionIndex('/o/payouts', sections)).toBe(1);
    expect(activeSectionIndex('/elsewhere', sections)).toBe(-1);
  });
});

describe('quick navigation', () => {
  const entries = quickNavEntries([
    { label: 'Payment config', href: '/pc', group: 'Configuration' },
    { label: 'Payouts', href: '/po', group: 'Money', keywords: ['settle'] },
    { label: 'Booking fees', href: '/bf', keywords: ['fee rules'] },
  ]);

  it('lists everything for an empty query, in menu order', () => {
    expect(filterQuickNav(entries, '  ').map((e) => e.href)).toEqual(['/pc', '/po', '/bf']);
  });

  it('needs every word, anywhere in the label, group or keywords', () => {
    expect(filterQuickNav(entries, 'pay conf').map((e) => e.href)).toEqual(['/pc']);
    expect(filterQuickNav(entries, 'settle').map((e) => e.href)).toEqual(['/po']);
    expect(filterQuickNav(entries, 'zzz')).toEqual([]);
  });

  it('ranks a label that starts with the query first', () => {
    expect(filterQuickNav(entries, 'fee').map((e) => e.href)).toEqual(['/bf']);
    expect(filterQuickNav(entries, 'pay').map((e) => e.href)).toEqual(['/pc', '/po']);
    expect(filterQuickNav(entries, 'money')[0].href).toBe('/po');
  });
});
