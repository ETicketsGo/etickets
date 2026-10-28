import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
  Which company a server-rendered legal page names. Narrower than the policy jurisdiction on
  purpose: `etg_market` may hold the network edge's guess, and a guess is not enough to tell
  somebody which company they deal with. Only an explicit request or a market the reader chose.
*/
let jar: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
  }),
}));

import { resolveJurisdiction, resolveSelectedMarket } from './market';

beforeEach(() => {
  jar = {};
});

describe('resolveSelectedMarket', () => {
  it('an explicit ?country= wins', async () => {
    jar.etg_selected_market = 'US';
    expect(await resolveSelectedMarket('IN')).toBe('IN');
  });

  it('then the market the reader chose', async () => {
    jar.etg_selected_market = 'US';
    expect(await resolveSelectedMarket(undefined)).toBe('US');
  });

  it('never the network guess alone: etg_market by itself selects nothing', async () => {
    jar.etg_market = 'IN';
    expect(await resolveSelectedMarket(undefined)).toBeNull();
    // The policy version still follows the product market, as before.
    expect(await resolveJurisdiction(undefined)).toBe('IN');
  });

  it('nothing at all is null, and the page names both companies', async () => {
    expect(await resolveSelectedMarket(undefined)).toBeNull();
  });
});
