import { computeTax } from './tax-calculator';

/**
 * The platform fee is quoted BEFORE its own GST, and the ticket price after.
 *
 * ── THE DECISION THIS PINS ─────────────────────────────────────────────────────────
 * A fee band is the amount the platform charges, and the GST on that supply is charged to
 * the buyer on top: a ₹20 band is ₹23.60 at checkout. The alternative reading — the band
 * being the all-in figure — collects ₹20 from the buyer, remits ₹3.05 of it, and leaves the
 * platform ₹16.95 for a fee it had set at ₹20. Silently, and on every order.
 *
 * These are opposite answers to the same field, and the India seed had answered BOTH with
 * `inclusive: true`, which is right for a ticket and wrong for a fee:
 *
 *   ticket   the number on the poster is what you pay      → extract the tax from it
 *   fee      the platform charges ₹20 for its service      → add the tax to it
 *
 * Adding tax on top of a ticket price would have raised every advertised price by the rate
 * the moment these rules were switched on, which is why the inclusive default existed at
 * all. It just was not a decision that generalised.
 */
const rule = (over: Record<string, unknown> = {}) =>
  ({
    id: 'r',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'TICKETS',
    inclusive: true,
    split: 'CGST_SGST',
    taxGroup: '',
    category: '*',
    country: 'India',
    region: '*',
    currency: 'INR',
    priority: 100,
    active: true,
    minUnitMinor: null,
    maxUnitMinor: null,
    ...over,
  }) as never;

/** One ₹150 ticket, and a ₹20 platform fee. */
const order = (rules: unknown[]) =>
  computeTax({
    netSubtotalMinor: 15_000,
    customerFeeMinor: 2_000,
    admissionLines: [{ unitPriceMinor: 15_000, quantity: 1 }],
    rules: rules as never,
    place: {
      country: 'India',
      region: 'TG',
      supplierRegion: 'TG',
      customerRegion: 'TG',
      currency: 'INR',
    },
  });

describe('the fee is charged on top of the band', () => {
  const feeRule = rule({ appliesTo: 'FEES', inclusive: false });

  it('adds 18% to a ₹20 band, so the buyer pays ₹23.60', () => {
    const r = order([feeRule]);
    expect(r.taxMinor).toBe(360);
    // taxAddedMinor is what the total grows by. ₹20.00 + ₹3.60 = ₹23.60.
    expect(r.taxAddedMinor).toBe(360);
  });

  it('leaves the platform the whole ₹20 it set', () => {
    /*
      The point of the decision. Whatever the rate turns out to be, the band is what the
      platform keeps — so a rate change moves what the buyer pays, not what the platform
      earns, and the bands do not have to be re-entered every time a rate moves.
    */
    const r = order([feeRule]);
    const feeLine = r.taxLines.find((l) => l.basis === 'FEES')!;
    expect(feeLine.baseMinor).toBe(2_000);
  });

  it('would have quietly taken ₹3.05 out of the same band if marked inclusive', () => {
    // Not a hypothetical: this is what the seeded rule did before it was split by appliesTo.
    const r = order([rule({ appliesTo: 'FEES', inclusive: true })]);
    expect(r.taxAddedMinor).toBe(0);
    expect(r.taxMinor).toBe(305);
    expect(r.taxLines.find((l) => l.basis === 'FEES')!.baseMinor).toBe(1_695);
  });
});

describe('the ticket price still contains its own tax', () => {
  const ticketRule = rule({ appliesTo: 'TICKETS', inclusive: true });

  it('extracts GST from ₹150 rather than adding it', () => {
    // A ₹150 poster price stays ₹150. The tax comes out of it: ₹150 / 1.18 = ₹127.12 net.
    const r = order([ticketRule]);
    expect(r.taxAddedMinor).toBe(0);
    expect(r.taxMinor).toBe(2_288);
  });

  it('does not change what the customer is advertised', () => {
    /*
      The reason the inclusive default existed. Switching these rules on must not reprice
      the catalogue — a ₹150 seat is ₹150 before and after.
    */
    const r = order([ticketRule]);
    expect(15_000 + r.taxAddedMinor).toBe(15_000);
  });
});

describe('both on one order, which is every real Indian booking', () => {
  it('charges ₹150 for the seat and ₹23.60 for the fee', () => {
    const r = order([
      rule({ id: 't', appliesTo: 'TICKETS', inclusive: true, taxGroup: 'ADMISSION' }),
      rule({ id: 'f', appliesTo: 'FEES', inclusive: false, taxGroup: 'FEE' }),
    ]);

    // The order total grows only by the fee's tax; the seat's was already inside the price.
    expect(r.taxAddedMinor).toBe(360);
    expect(15_000 + 2_000 + r.taxAddedMinor).toBe(17_360);

    // And the invoice still itemises both, because one of them being invisible in the total
    // does not make it invisible to the tax authority.
    const bases = r.taxLines.map((l) => l.basis);
    expect(bases).toContain('TICKETS');
    expect(bases).toContain('FEES');
  });
});
