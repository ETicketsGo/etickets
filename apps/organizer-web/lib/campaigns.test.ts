import { describe, expect, it } from 'vitest';
import type { CampaignsStatus } from '@eticketsgo/web-kit';
import {
  STATUS_WORDS,
  audienceProblems,
  campaignGate,
  designProblems,
  pausedReasonText,
  percent,
  setupProblems,
  zonedLocalToIso,
} from './campaigns';

const ready: CampaignsStatus = {
  enabled: true,
  planCode: 'PRO',
  sending: { allowed: true, mode: 'SHARED_TRANSACTIONAL', refusal: null },
  entitlements: {
    create: true,
    schedule: true,
    analyticsBasic: true,
    analyticsAdvanced: false,
    audienceAdvanced: false,
  },
  quota: { periodKey: '2026-10', quota: 2000, used: 0, credits: 0, remaining: 2000 },
  defaults: { quietHours: { start: '21:00', end: '08:00' } },
  templates: [],
};

describe('campaign gate', () => {
  it('says "coming soon" when the deployment has campaigns off, and never offers a send', () => {
    expect(campaignGate({ ...ready, enabled: false })).toMatchObject({ kind: 'off' });
  });
  it('points at the plan when the entitlement is missing', () => {
    const g = campaignGate({ ...ready, entitlements: { ...ready.entitlements, create: false } });
    expect(g).toMatchObject({ kind: 'plan', title: expect.stringMatching(/Pro and Premium/) });
  });
  it('is ready otherwise', () => {
    expect(campaignGate(ready)).toEqual({ kind: 'ready' });
  });
});

describe('words', () => {
  it('every status has a label and the words are plain ASCII', () => {
    for (const [, w] of Object.entries(STATUS_WORDS)) {
      expect(w.label).toMatch(/^[\x20-\x7E]+$/);
    }
  });
  it('explains a pause', () => {
    expect(pausedReasonText('QUOTA_EXHAUSTED')).toMatch(/no emails left/);
    expect(pausedReasonText('ADMIN')).toMatch(/Contact support/);
    expect(pausedReasonText(null)).toBeNull();
  });
  it('formats a rate', () => {
    expect(percent(0.125)).toBe('13%');
    expect(percent(0.034)).toBe('3.4%');
    expect(percent(null)).toBe('-');
  });
});

describe('step checks', () => {
  it('setup', () => {
    expect(setupProblems({ name: 'x', subject: 'y', senderName: 'z' })).toEqual([]);
    expect(setupProblems({})).toHaveLength(3);
  });
  it('audience', () => {
    expect(audienceProblems({ sources: [] })).toHaveLength(1);
    expect(audienceProblems({ sources: ['EVENT_BUYERS'] })[0]).toMatch(/at least one event/);
    expect(audienceProblems({ sources: ['FOLLOWERS'] })).toEqual([]);
  });
  it('design', () => {
    expect(designProblems([])).toHaveLength(1);
    expect(designProblems([{ type: 'button', label: 'Go', url: 'http://x' }])[0]).toMatch(/https/);
    expect(designProblems([{ type: 'paragraph', text: 'Hi' }])).toEqual([]);
  });
});

describe('zoned local time', () => {
  it('reads a wall-clock time in the chosen zone', () => {
    expect(zonedLocalToIso('2026-10-28T19:30', 'Asia/Kolkata')).toBe('2026-10-28T14:00:00.000Z');
    expect(zonedLocalToIso('2026-11-02T09:00', 'America/New_York')).toBe(
      '2026-11-02T14:00:00.000Z',
    );
    expect(zonedLocalToIso('2026-10-30T09:00', 'America/New_York')).toBe(
      '2026-10-30T13:00:00.000Z',
    );
    expect(zonedLocalToIso('nope', 'UTC')).toBeNull();
  });
});
