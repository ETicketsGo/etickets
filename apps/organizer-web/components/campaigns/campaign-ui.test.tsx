import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AudienceCounts,
  BarList,
  CampaignGateNotice,
  CampaignStatusChip,
  SendingModeNote,
  SeriesBars,
} from './campaign-ui';

/*
  The campaign pages never show a dead button: a missing plan says so and links to plans; a
  switched-off deployment says "coming soon" with nothing to press. Counts are counts.
*/

describe('campaign gate notice', () => {
  it('a missing plan links to Billing & plans', () => {
    const html = renderToStaticMarkup(
      <CampaignGateNotice
        gate={{
          kind: 'plan',
          title: 'Email campaigns are part of the Pro and Premium plans',
          hint: 'Upgrade.',
        }}
      />,
    );
    expect(html).toContain('campaign-gate-plan');
    expect(html).toContain('href="/organizer/billing"');
    expect(html).toContain('See plans');
  });
  it('a switched-off deployment offers nothing to press', () => {
    const html = renderToStaticMarkup(
      <CampaignGateNotice
        gate={{ kind: 'off', title: 'Email campaigns are coming soon', hint: 'Not yet.' }}
      />,
    );
    expect(html).toContain('coming soon');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<button');
  });
});

describe('campaign status chip', () => {
  it('says the status in words', () => {
    expect(renderToStaticMarkup(<CampaignStatusChip status="PARTIALLY_FAILED" />)).toContain(
      'Sent, some failed',
    );
  });
});

describe('audience counts', () => {
  it('shows who will get it and why the rest will not, and the plan cost', () => {
    const html = renderToStaticMarkup(
      <AudienceCounts
        counts={{
          matched: 10,
          eligible: 4,
          noConsent: 3,
          suppressedGlobal: 1,
          suppressedOrganizer: 2,
          estimatedCredits: 4,
          quotaRemaining: 100,
          enoughQuota: true,
        }}
      />,
    );
    expect(html).toContain('Will get it');
    expect(html).toContain('Not agreed');
    expect(html).toContain('10 people match. Sending uses 4 emails from your plan.');
    expect(html).not.toMatch(/@/);
  });
});

describe('charts', () => {
  it('bars carry their numbers in text, and an empty series says so', () => {
    const html = renderToStaticMarkup(
      <BarList label="x" rows={[{ key: 'a', label: 'Pune', value: 7 }]} />,
    );
    expect(html).toContain('Pune');
    expect(html).toContain('>7<');
    expect(
      renderToStaticMarkup(<BarList label="x" rows={[]} emptyText="Nothing here." />),
    ).toContain('Nothing here.');
    const series = renderToStaticMarkup(
      <SeriesBars label="New followers" points={[{ start: '2026-10-20', count: 3 }]} />,
    );
    expect(series).toContain('New followers: 2026-10-20 3');
  });
});

describe('review step sending-mode note', () => {
  it('SHARED_TRANSACTIONAL says settings are shared, never that the sender is the ticket sender', () => {
    const html = renderToStaticMarkup(<SendingModeNote mode="SHARED_TRANSACTIONAL" />);
    expect(html).toContain('shares some delivery settings with ticket mail');
    expect(html).not.toContain('same sender');
  });
  it('a dedicated or log-only sender shows no note', () => {
    expect(renderToStaticMarkup(<SendingModeNote mode="DEDICATED_MARKETING" />)).toBe('');
    expect(renderToStaticMarkup(<SendingModeNote mode="LOG_ONLY" />)).toBe('');
    expect(renderToStaticMarkup(<SendingModeNote mode={null} />)).toBe('');
  });
});
