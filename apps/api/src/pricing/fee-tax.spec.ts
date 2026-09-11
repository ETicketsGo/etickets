import { feeTaxSummary } from './fee-tax';

/**
 * Reported from QA: Review & pay listed ₹499 + ₹10.18 + ₹10 under "Total payable ₹522.82".
 * The booking carried its fee before tax only, so the ₹3.64 of GST on the fees vanished from
 * the screen while staying in the total.
 */
describe('feeTaxSummary', () => {
  const gst = (basis: string, amountMinor: number, inclusive: boolean) => ({
    basis,
    inclusive,
    amountMinor,
    rateBasisPoints: 900,
  });

  it('adds the GST charged on the fees to the fee, as the checkout quote does', () => {
    expect(
      feeTaxSummary(
        [
          gst('TICKETS', 3_806, true),
          gst('TICKETS', 3_806, true),
          gst('FEES', 182, false),
          gst('FEES', 182, false),
        ],
        2_018,
      ),
    ).toEqual({ customerFeeInclusiveMinor: 2_382, feeTaxMinor: 364, feeTaxRateBasisPoints: 1_800 });
  });

  it('leaves the fee alone when its tax was already inside it', () => {
    expect(feeTaxSummary([gst('FEES', 300, true)], 2_000)).toMatchObject({
      customerFeeInclusiveMinor: 2_000,
      feeTaxMinor: 300,
    });
  });

  it('is the fee itself, with no tax, when nothing was charged on the fees', () => {
    expect(feeTaxSummary([gst('TICKETS', 3_806, true)], 2_018)).toEqual({
      customerFeeInclusiveMinor: 2_018,
      feeTaxMinor: 0,
      feeTaxRateBasisPoints: 0,
    });
    expect(feeTaxSummary(undefined, 500).customerFeeInclusiveMinor).toBe(500);
  });
});
