import { describe, expect, it } from 'vitest';
import {
  razorpayPanelMessage,
  stripePanelMessage,
  type MarketScope,
  type RazorpayFacts,
  type StripeFacts,
} from './provider-panel-messages';

/*
  Provider x state x market. The server facts these mirror: Stripe (USD/CAD) refuses a paid booking
  without a connected account with charges enabled; Razorpay (INR) never reads an organizer account
  at checkout. So only a Stripe panel may ever say "cannot sell", and only about dollars.
*/
const US_ONLY: MarketScope = { inr: false, card: true };
const IN_ONLY: MarketScope = { inr: true, card: false };
const BOTH: MarketScope = { inr: true, card: true };

const stripe = (over: Partial<StripeFacts>): StripeFacts => ({
  hasAccount: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  canSellPaidTickets: true,
  ...over,
});
const razorpay = (over: Partial<RazorpayFacts>): RazorpayFacts => ({
  hasAccount: true,
  payoutsEnabled: true,
  routeEnabled: true,
  payoutReady: true,
  ...over,
});

const STRIPE_STATES: Record<string, Partial<StripeFacts>> = {
  'no account': {
    hasAccount: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    canSellPaidTickets: false,
  },
  'details incomplete': { chargesEnabled: false, payoutsEnabled: false, canSellPaidTickets: false },
  'charges on, payouts off': { payoutsEnabled: false },
  active: {},
};
const RAZORPAY_STATES: Record<string, Partial<RazorpayFacts>> = {
  'platform settlements off': { routeEnabled: false, payoutReady: false, hasAccount: false },
  'settlements on, not linked': { hasAccount: false, payoutsEnabled: false, payoutReady: false },
  'linked, payouts not started': { payoutsEnabled: false, payoutReady: false },
  active: {},
};

describe('Stripe panel (the provider that gates dollar sales)', () => {
  it.each(['no account', 'details incomplete'])('%s: warns that dollar sales are blocked', (s) => {
    const m = stripePanelMessage(stripe(STRIPE_STATES[s]), US_ONLY);
    expect(m?.tone).toBe('warning');
    expect(m?.text).toMatch(/before you can sell paid tickets in US or Canadian dollars/);
    expect(m?.text).not.toMatch(/rupee/i);
  });

  it('tells a two-market organizer that rupee sales continue', () => {
    const m = stripePanelMessage(stripe(STRIPE_STATES['details incomplete']), BOTH);
    expect(m?.text).toMatch(/rupees are not affected/);
  });

  it('charges on, payouts off: sales are fine, only payouts wait', () => {
    const m = stripePanelMessage(stripe(STRIPE_STATES['charges on, payouts off']), US_ONLY);
    expect(m?.tone).toBe('info');
    expect(m?.text).toMatch(/You can sell paid tickets/);
    expect(m?.text).not.toMatch(/must finish/);
  });

  it('active: says nothing', () => {
    expect(stripePanelMessage(stripe({}), US_ONLY)).toBeNull();
  });

  it('a charges flag without an account id is still blocked, as the server gate requires both', () => {
    const m = stripePanelMessage(stripe({ hasAccount: false }), US_ONLY);
    expect(m?.tone).toBe('warning');
  });
});

describe('Razorpay panel (never gates sales)', () => {
  const scopes: [string, MarketScope][] = [
    ['India only', IN_ONLY],
    ['both markets', BOTH],
  ];

  describe.each(scopes)('%s', (_n, scope) => {
    it.each(Object.keys(RAZORPAY_STATES))('%s: never implies a sales block', (s) => {
      const m = razorpayPanelMessage(razorpay(RAZORPAY_STATES[s]), scope);
      expect(m.text).not.toMatch(/before you can sell|cannot sell|must finish/i);
      if (s !== 'active') expect(m.text).toMatch(/sales .*unaffected|sales are unaffected/i);
      expect(m.tone).not.toBe('warning');
    });
  });

  it('only the active state is a success', () => {
    const tones = Object.entries(RAZORPAY_STATES).map(
      ([k, v]) => [k, razorpayPanelMessage(razorpay(v), IN_ONLY).tone] as const,
    );
    expect(tones.filter(([, t]) => t === 'success').map(([k]) => k)).toEqual(['active']);
  });

  it('names rupees only when the organizer also sells in another currency', () => {
    expect(razorpayPanelMessage(razorpay({ payoutReady: false }), IN_ONLY).text).not.toMatch(
      /rupee/,
    );
    expect(razorpayPanelMessage(razorpay({ payoutReady: false }), BOTH).text).toMatch(/rupee/);
  });

  it('distinguishes all four states', () => {
    const texts = Object.values(RAZORPAY_STATES).map(
      (v) => razorpayPanelMessage(razorpay(v), IN_ONLY).text,
    );
    expect(new Set(texts).size).toBe(4);
  });
});

describe('the two panels together never contradict', () => {
  it('a US-only organizer sees no Razorpay claim, and an India-only organizer no Stripe claim', () => {
    // Market scoping is the page's job (a panel is not rendered); the messages themselves are
    // each about one currency and say so.
    const s = stripePanelMessage(stripe(STRIPE_STATES['no account']), BOTH);
    const r = razorpayPanelMessage(razorpay(RAZORPAY_STATES['settlements on, not linked']), BOTH);
    expect(s?.text).toMatch(/US or Canadian dollars/);
    expect(r.text).toMatch(/rupees/);
  });
});
