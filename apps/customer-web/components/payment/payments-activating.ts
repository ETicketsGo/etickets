/**
 * What the "online payment is being activated" panel may say, for a booking in this currency.
 *
 * The panel named "Card, UPI and netbanking" and an operator in Hyderabad to every buyer. A US
 * buyer of a USD arena ticket was told about UPI. The India wording belongs to the India
 * gateway, which is the one that takes INR - the same rule the payment routing follows - so
 * any other currency gets wording that names no payment method and no country.
 */
export function paymentsActivatingCopy(currency: string | null | undefined): {
  body: 'paymentsActivatingBody' | 'paymentsActivatingBodyGeneric';
  showOperator: boolean;
} {
  const india = (currency ?? '').trim().toUpperCase() === 'INR';
  return india
    ? { body: 'paymentsActivatingBody', showOperator: true }
    : { body: 'paymentsActivatingBodyGeneric', showOperator: false };
}
