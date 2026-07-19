import { describe, it, expect } from 'vitest';
import { priceBundle, priceAddOnLine, bundleListUnitMinor } from '@eticketsgo/shared-types';

const components = [
  { refId: 't1', isTicket: true, listUnitPriceMinor: 10000, quantity: 2 }, // ₹100 × 2
  { refId: 'a1', isTicket: false, listUnitPriceMinor: 5000, quantity: 1 }, // ₹50 × 1
];

describe('bundleListUnitMinor', () => {
  it('sums component list prices for one bundle', () => {
    expect(bundleListUnitMinor(components)).toBe(25000);
  });
});

describe('priceBundle — FIXED', () => {
  it('charges the fixed price and keeps lineTotal = unit × qty on every line', () => {
    const r = priceBundle({
      pricingKind: 'FIXED',
      fixedPriceMinor: 20000,
      components,
      bundleQuantity: 1,
    });
    // ratio 20000/25000 = 0.8 → ticket unit 8000, addon unit 4000 → 8000×2 + 4000 = 20000
    expect(r.bundleUnitPriceMinor).toBe(20000);
    expect(r.totalMinor).toBe(20000);
    expect(r.listTotalMinor).toBe(25000);
    expect(r.savingsMinor).toBe(5000);
    for (const c of r.components) {
      expect(c.lineTotalMinor).toBe(c.unitPriceMinor * c.quantity);
    }
  });

  it('multiplies by bundle quantity', () => {
    const r = priceBundle({
      pricingKind: 'FIXED',
      fixedPriceMinor: 20000,
      components,
      bundleQuantity: 3,
    });
    expect(r.totalMinor).toBe(60000);
    expect(r.components.find((c) => c.refId === 't1')?.quantity).toBe(6);
  });
});

describe('priceBundle — PERCENT_DISCOUNT', () => {
  it('applies the percentage per unit', () => {
    const r = priceBundle({
      pricingKind: 'PERCENT_DISCOUNT',
      discountPercent: 10,
      components,
      bundleQuantity: 1,
    });
    // 10% off: ticket 9000, addon 4500 → 9000×2 + 4500 = 22500
    expect(r.bundleUnitPriceMinor).toBe(22500);
    expect(r.savingsMinor).toBe(2500);
  });

  it('clamps an out-of-range percent to [0,100]', () => {
    const full = priceBundle({
      pricingKind: 'PERCENT_DISCOUNT',
      discountPercent: 250,
      components,
      bundleQuantity: 1,
    });
    expect(full.totalMinor).toBe(0);
    expect(full.savingsMinor).toBe(25000);
  });
});

describe('priceAddOnLine', () => {
  it('computes an integer line total', () => {
    expect(priceAddOnLine(2500, 3)).toEqual({
      unitPriceMinor: 2500,
      quantity: 3,
      lineTotalMinor: 7500,
    });
  });
});
