/**
 * Pure Experience Commerce pricing (v1.3). Frameworks-free so it can be unit-tested
 * and shared by the API and the web apps. Money is integer minor units throughout.
 *
 * Bundles are priced per unit: an effective ratio (fixed target / list sum, or the
 * percent discount) is applied to each component's list price and rounded. That keeps
 * the BookingItem invariant `lineTotalMinor === unitPriceMinor * quantity` exact on
 * every expanded line, at the cost of at most a few minor units of drift from the
 * headline bundle price — which is reported back as the actual charged price.
 */
import type { BundlePricingKind } from './enums';

export interface BundleComponentInput {
  /** ticketTypeId or addOnId of the component. */
  refId: string;
  isTicket: boolean;
  listUnitPriceMinor: number;
  /** Units of this component in a single bundle. */
  quantity: number;
}

export interface BundlePricedComponent {
  refId: string;
  isTicket: boolean;
  /** Total units across all purchased bundles (perBundleQty × bundleQuantity). */
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface BundlePricingResult {
  /** Charged price of a single bundle (sum of rounded component unit prices). */
  bundleUnitPriceMinor: number;
  /** bundleUnitPriceMinor × bundleQuantity. */
  totalMinor: number;
  /** Sum of component list prices for the purchased quantity (pre-discount). */
  listTotalMinor: number;
  /** listTotalMinor − totalMinor, never negative. */
  savingsMinor: number;
  components: BundlePricedComponent[];
}

/** List price of one bundle: Σ component listUnit × perBundleQty. */
export function bundleListUnitMinor(components: BundleComponentInput[]): number {
  return components.reduce((sum, c) => sum + c.listUnitPriceMinor * c.quantity, 0);
}

export interface PriceBundleInput {
  pricingKind: BundlePricingKind;
  fixedPriceMinor?: number | null;
  discountPercent?: number | null;
  components: BundleComponentInput[];
  bundleQuantity: number;
}

export function priceBundle(input: PriceBundleInput): BundlePricingResult {
  const { pricingKind, components, bundleQuantity } = input;
  const listUnit = bundleListUnitMinor(components);

  // Effective per-unit multiplier the discount implies.
  let ratio = 1;
  if (pricingKind === 'FIXED') {
    const target = Math.max(0, Math.round(input.fixedPriceMinor ?? 0));
    ratio = listUnit > 0 ? target / listUnit : 0;
  } else {
    const pct = clampPercent(input.discountPercent ?? 0);
    ratio = (100 - pct) / 100;
  }

  const priced: BundlePricedComponent[] = components.map((c) => {
    const unit = Math.max(0, Math.round(c.listUnitPriceMinor * ratio));
    const quantity = c.quantity * bundleQuantity;
    return {
      refId: c.refId,
      isTicket: c.isTicket,
      quantity,
      unitPriceMinor: unit,
      lineTotalMinor: unit * quantity,
    };
  });

  const bundleUnitPriceMinor = components.reduce(
    (sum, c) => sum + Math.max(0, Math.round(c.listUnitPriceMinor * ratio)) * c.quantity,
    0,
  );
  const totalMinor = bundleUnitPriceMinor * bundleQuantity;
  const listTotalMinor = listUnit * bundleQuantity;

  return {
    bundleUnitPriceMinor,
    totalMinor,
    listTotalMinor,
    savingsMinor: Math.max(0, listTotalMinor - totalMinor),
    components: priced,
  };
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

/** A simple add-on line: unit price × quantity. */
export function priceAddOnLine(
  unitPriceMinor: number,
  quantity: number,
): { unitPriceMinor: number; quantity: number; lineTotalMinor: number } {
  const unit = Math.max(0, Math.round(unitPriceMinor));
  const qty = Math.max(0, Math.trunc(quantity));
  return { unitPriceMinor: unit, quantity: qty, lineTotalMinor: unit * qty };
}
