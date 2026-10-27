import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AudienceSummary } from '@eticketsgo/web-kit';
import { AudienceBody } from './audience-overview';

/*
  Audience & growth shows counts the API returned, and nothing else: placeholders while it
  loads, a sentence when it fails, an honest empty state at zero, and never a person.
*/

const week = (start: string, newFollowers: number, followers: number) => ({
  start,
  newFollowers,
  followers,
});

const summary: AudienceSummary = {
  organizationId: 'org-1',
  generatedAt: '2026-10-27T10:00:00.000Z',
  followers: { total: 42, new7d: 5, new30d: 17 },
  eligibleSubscribers: 9,
  returningBuyers: 6,
  growth: {
    daily: [],
    weekly: [week('2026-10-12', 3, 37), week('2026-10-19', 2, 39), week('2026-10-26', 3, 42)],
  },
  cities: {
    buckets: [{ city: 'Vijayawada', country: 'India', followers: 12 }],
    hiddenBuckets: 2,
    threshold: 5,
  },
};

describe('the audience overview', () => {
  it('shows placeholders, not numbers, while it loads', () => {
    const html = renderToStaticMarkup(<AudienceBody state="loading" />);
    expect(html).toContain('data-testid="audience-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it('says it failed, with a retry, and invents no figures', () => {
    const html = renderToStaticMarkup(<AudienceBody state="error" onRetry={() => {}} />);
    expect(html).toContain('We could not load your audience figures');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Followers at week end');
  });

  it('tells staff without access why, without a retry that cannot work', () => {
    const html = renderToStaticMarkup(<AudienceBody state="error" forbidden onRetry={() => {}} />);
    expect(html).toContain('Only owners and managers');
    expect(html).not.toContain('Try again');
  });

  it('has an honest empty state at zero followers', () => {
    const html = renderToStaticMarkup(
      <AudienceBody
        state="ready"
        data={{ ...summary, followers: { total: 0, new7d: 0, new30d: 0 } }}
      />,
    );
    expect(html).toContain('No followers yet');
    expect(html).not.toContain('Email subscribers');
  });

  it('shows the counts, the weekly growth and the cities above the threshold', () => {
    const html = renderToStaticMarkup(<AudienceBody state="ready" data={summary} />);
    for (const text of [
      'Followers',
      '42',
      '5 new in 7 days, 17 in 30 days',
      'Email subscribers',
      '9',
      'Returning buyers',
      'Following is not permission to email',
      'Vijayawada',
      '2 smaller cities are hidden',
    ]) {
      expect(html).toContain(text);
    }
    expect((html.match(/<tr>/g) ?? []).length).toBe(1 + summary.growth.weekly.length);
  });
});
