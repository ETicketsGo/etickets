/**
 * Every amount a booking screen prints, so ONE decision about decimals covers all of them.
 *
 * Review & pay did this; the confirmation decided from the order lines alone and printed
 * "300" and "Includes Rs 46 GST" for what payment had shown as "300.00" and "45.76". A
 * whole-rupee order can still carry paise in its tax, and an amount missing from this list is
 * rounded by the decision the others made. Both screens read this list so they cannot differ.
 */
export interface BookingAmountsInput {
  items: { unitPriceMinor: number; quantity: number }[];
  subtotalMinor: number;
  discountMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  customerFeeMinor?: number | null;
  feeTaxMinor?: number | null;
  maintenanceMinor?: number | null;
  taxLines?: { amountMinor: number }[] | null;
  totalMinor: number;
}

export function bookingAmounts(b: BookingAmountsInput): number[] {
  return [
    ...b.items.map((i) => i.unitPriceMinor * i.quantity),
    b.subtotalMinor,
    b.discountMinor,
    b.bookingFeeMinor,
    b.paymentFeeMinor,
    b.customerFeeMinor ?? 0,
    b.feeTaxMinor ?? 0,
    b.maintenanceMinor ?? 0,
    ...(b.taxLines ?? []).map((l) => l.amountMinor),
    b.totalMinor,
  ];
}
