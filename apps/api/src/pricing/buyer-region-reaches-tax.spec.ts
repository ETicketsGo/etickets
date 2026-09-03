import { PricingService } from './pricing.service';

/**
 * What the buyer picked has to actually arrive at the tax engine.
 *
 * ── WHY THIS IS ITS OWN FILE ───────────────────────────────────────────────────────
 * The engine has accepted a buyer's state for a while and decided IGST against CGST + SGST
 * from it, and the calculator's own tests prove that arithmetic. None of them prove that
 * anything ever SUPPLIES it — and nothing did. Checkout collected no state, so every order
 * on the platform was treated as intra-state regardless of who bought it.
 *
 * That is the shape of failure this file exists for: a capability that is built, tested,
 * correct, and unreached. The tests below are about the wire, not the arithmetic.
 */
const taxSpy = () => ({
  quote: jest.fn().mockResolvedValue({
    taxLines: [],
    taxMinor: 0,
    taxAddedMinor: 0,
    provider: 'manual',
    providerRef: null,
  }),
});

const service = (tax: ReturnType<typeof taxSpy>, config: Record<string, string> = {}) =>
  new PricingService(
    { feeRule: { findMany: jest.fn().mockResolvedValue([]) } } as never,
    tax as never,
    { get: (k: string) => config[k] } as never,
  );

/** The context the pricing service handed to the tax provider. */
const contextOf = (tax: ReturnType<typeof taxSpy>) => tax.quote.mock.calls[0][0].context;

describe('the buyer’s state reaches the tax provider', () => {
  it('passes through what checkout collected', async () => {
    const tax = taxSpy();
    await service(tax).quote(50_000, 'CUSTOMER_PAYS', 0, 'INR', {
      country: 'India',
      region: 'Telangana',
      supplierRegion: 'Telangana',
      customerRegion: 'Maharashtra',
    });
    expect(contextOf(tax).customerRegion).toBe('Maharashtra');
  });

  it('keeps the venue’s state and the buyer’s state as separate facts', async () => {
    /*
      The distinction the whole feature rests on. Admission follows where the event is;
      a platform's service follows where the recipient is. Collapsing them is what made one
      real competitor's order — CGST + SGST on the ticket, IGST on the fee — impossible to
      reproduce here.
    */
    const tax = taxSpy();
    await service(tax).quote(50_000, 'CUSTOMER_PAYS', 0, 'INR', {
      country: 'India',
      region: 'Telangana',
      supplierRegion: 'Telangana',
      customerRegion: 'Karnataka',
    });
    const ctx = contextOf(tax);
    expect(ctx.region).toBe('Telangana');
    expect(ctx.customerRegion).toBe('Karnataka');
  });

  it('stamps the platform’s own state from configuration, not from the order', async () => {
    // Where the PLATFORM is registered is a fact about the company, identical on every
    // order, and has no business being sent by a client.
    const tax = taxSpy();
    await service(tax, { PLATFORM_TAX_REGION: 'Telangana' }).quote(
      50_000,
      'CUSTOMER_PAYS',
      0,
      'INR',
      { country: 'India', customerRegion: 'Maharashtra' },
    );
    expect(contextOf(tax).platformRegion).toBe('Telangana');
  });

  it('sends null rather than a guess when PLATFORM_TAX_REGION is unset', async () => {
    /*
      Unset is the state this ships in. Null means "unknown", and the calculator treats an
      unknown side as NOT crossing a border — so an unconfigured platform charges CGST +
      SGST, which is both the safe answer and the same amount. Substituting the venue's
      state here would be a guess that looks like a fact on an invoice.
    */
    const tax = taxSpy();
    await service(tax).quote(50_000, 'CUSTOMER_PAYS', 0, 'INR', {
      country: 'India',
      region: 'Telangana',
      customerRegion: 'Maharashtra',
    });
    expect(contextOf(tax).platformRegion).toBeNull();
  });

  it('survives a caller that names no buyer at all', async () => {
    // Every pre-existing caller, and every order where the buyer declined to say.
    const tax = taxSpy();
    await service(tax).quote(50_000, 'CUSTOMER_PAYS', 0, 'INR', { country: 'India' });
    expect(contextOf(tax).customerRegion).toBeUndefined();
  });
});
