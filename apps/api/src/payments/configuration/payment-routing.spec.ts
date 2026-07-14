import { selectMerchant, selectRoute, type MerchantRow, type RouteRow } from './payment-routing';

const routes: RouteRow[] = [
  {
    country: 'IN',
    currency: 'INR',
    method: '*',
    provider: 'razorpay',
    failoverProvider: 'stripe',
    priority: 10,
  },
  { country: 'US', currency: 'USD', method: '*', provider: 'stripe', priority: 10 },
  { country: '*', currency: '*', method: '*', provider: 'stripe', priority: 100 },
];

describe('selectRoute', () => {
  it('picks the most specific matching route', () => {
    expect(selectRoute(routes, { country: 'IN', currency: 'INR' })).toEqual({
      provider: 'razorpay',
      failoverProvider: 'stripe',
    });
  });
  it('is case-insensitive on country/currency', () => {
    expect(selectRoute(routes, { country: 'in', currency: 'inr' })?.provider).toBe('razorpay');
  });
  it('falls back to the wildcard catch-all when nothing specific matches', () => {
    expect(selectRoute(routes, { country: 'FR', currency: 'EUR' })).toEqual({
      provider: 'stripe',
      failoverProvider: undefined,
    });
  });
  it('treats an unspecified country as wildcard (catch-all)', () => {
    expect(selectRoute(routes, { currency: 'EUR' })?.provider).toBe('stripe');
  });
  it('returns null when no route (not even a catch-all) matches', () => {
    const noCatchAll = routes.filter((r) => r.country !== '*');
    expect(selectRoute(noCatchAll, { country: 'FR', currency: 'EUR' })).toBeNull();
  });
  it('prefers a specific route over the catch-all even when listed later', () => {
    const reordered = [...routes].reverse();
    expect(selectRoute(reordered, { country: 'US', currency: 'USD' })?.provider).toBe('stripe');
  });
  it('breaks specificity ties by lower priority', () => {
    const tie: RouteRow[] = [
      { country: 'IN', currency: '*', method: '*', provider: 'b', priority: 50 },
      { country: 'IN', currency: '*', method: '*', provider: 'a', priority: 5 },
    ];
    expect(selectRoute(tie, { country: 'IN', currency: 'INR' })?.provider).toBe('a');
  });
  it('does not match a method-specific route when the query omits method', () => {
    const methodRoutes: RouteRow[] = [
      { country: '*', currency: '*', method: 'UPI', provider: 'razorpay', priority: 10 },
      { country: '*', currency: '*', method: '*', provider: 'stripe', priority: 100 },
    ];
    expect(selectRoute(methodRoutes, { currency: 'INR' })?.provider).toBe('stripe');
    expect(selectRoute(methodRoutes, { currency: 'INR', method: 'UPI' })?.provider).toBe(
      'razorpay',
    );
  });
});

describe('selectMerchant', () => {
  const merchants: MerchantRow[] = [
    { label: 'any', country: null, currency: null, active: true },
    { label: 'india', country: 'IN', currency: 'INR', active: true },
    { label: 'inactive-us', country: 'US', currency: 'USD', active: false },
  ];
  it('prefers the most specific active account', () => {
    expect(selectMerchant(merchants, 'IN', 'INR')?.label).toBe('india');
  });
  it('falls back to the catch-all account', () => {
    expect(selectMerchant(merchants, 'FR', 'EUR')?.label).toBe('any');
  });
  it('ignores inactive accounts (falls back to catch-all)', () => {
    expect(selectMerchant(merchants, 'US', 'USD')?.label).toBe('any');
  });
  it('returns null when nothing matches', () => {
    expect(
      selectMerchant([{ label: 'x', country: 'IN', currency: 'INR', active: true }], 'US', 'USD'),
    ).toBeNull();
  });
});
