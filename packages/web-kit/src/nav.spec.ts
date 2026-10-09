import { describe, expect, it } from 'vitest';
import { navCurrentHref, navInSection, type NavItem } from './nav';

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
