import {
  resolvePolicy,
  specificity,
  type PolicyContext,
  type PolicyRow,
} from './cinema-pricing-policy.resolver';
import { applyPolicy, checkTicketPrice } from './apply-policy';

/**
 * Which cinema pricing order governs a sale, and what it does to the money.
 *
 * ── WHAT THESE TESTS DELIBERATELY DO NOT ASSERT ────────────────────────────────────
 * That Andhra Pradesh charges ₹5, or that Telangana charges anything, or what any ceiling
 * is anywhere. Every amount below is a FIXTURE — a number invented for a test, chosen to be
 * obviously not a real rate. The engine holds no rupee of any government order, and a test
 * suite that encoded one would quietly become the place the law lived.
 *
 * What they do assert is the shape: that a per-ticket charge is charged per ticket, that an
 * included charge does not move a total, that a more specific rule wins, that two equally
 * specific rules are refused rather than guessed between, and that a regulated market with
 * no matching rule fails closed instead of falling back to the platform's own fee schedule.
 */
const JAN = new Date('2026-01-15T00:00:00Z');

const rule = (over: Partial<PolicyRow> = {}): PolicyRow => ({
  id: over.id ?? 'p1',
  version: 1,
  country: 'India',
  region: '*',
  district: '*',
  city: '*',
  currency: '*',
  localBodyType: null,
  cinemaFormat: null,
  climateType: null,
  seatCategory: null,
  maintenanceChargeMinor: 0,
  maintenanceTreatment: 'NOT_APPLICABLE',
  maintenanceTaxCategory: null,
  onlineFeePolicy: 'ALLOWED',
  onlineFeeCapMinor: null,
  ticketPriceMinMinor: null,
  ticketPriceMaxMinor: null,
  ticketPriceRule: null,
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  effectiveTo: null,
  regulatoryReference: 'FIXTURE-ORDER-1',
  ...over,
});

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  country: 'India',
  region: 'Andhra Pradesh',
  district: null,
  city: 'Vijayawada',
  currency: 'INR',
  localBodyType: null,
  cinemaFormat: null,
  climateType: 'AC',
  seatCategories: ['GOLD'],
  at: JAN,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('a market is regulated only when a row says so', () => {
  it('leaves an unclaimed country priced exactly as before', () => {
    /*
      The compatibility guarantee the whole design rests on. Every non-cinema event, and
      every market nobody has written an order for, must be untouched — so regulation is a
      DECLARATION made by inserting a row, never an inference.
    */
    const r = resolvePolicy([rule({ country: 'India' })], ctx({ country: 'Canada' }));
    expect(r.status).toBe('NOT_REGULATED');
    expect(applyPolicy(r, 2).maxOnlineFeeMinor).toBeNull();
    expect(applyPolicy(r, 2).maintenanceMinor).toBe(0);
  });

  it('FAILS CLOSED once a country is claimed but nothing covers the location', () => {
    /*
      The point of the exercise. India is regulated, this cinema is in a state nobody has
      written a rule for, and the tempting behaviour — fall back to the platform's ordinary
      fee schedule — is exactly the silent non-compliance being prevented.
    */
    const r = resolvePolicy(
      [rule({ region: 'Andhra Pradesh' })],
      ctx({ region: 'Maharashtra', city: 'Mumbai' }),
    );
    expect(r.status).toBe('POLICY_NOT_FOUND');
    expect(r.explanation).toContain('Maharashtra');
    // And nothing may be charged on the strength of a policy that was never found.
    expect(applyPolicy(r, 2).maxOnlineFeeMinor).toBe(0);
  });

  it('says CLASSIFICATION when that is the actual gap', () => {
    // A different job for a different person: somebody has to classify the cinema, not
    // write a government order. Reporting both as "no policy" sends them to the wrong task.
    const r = resolvePolicy(
      [rule({ region: 'Andhra Pradesh', climateType: 'AC' })],
      ctx({ climateType: null }),
    );
    expect(r.status).toBe('INVALID_CINEMA_CLASSIFICATION');
    expect(r.explanation).toMatch(/classif/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('precedence is deterministic', () => {
  it('lets a narrower rule beat a broader one', () => {
    const broad = rule({ id: 'broad', region: '*' });
    const narrow = rule({ id: 'narrow', region: 'Andhra Pradesh' });
    expect(resolvePolicy([broad, narrow], ctx()).policy?.id).toBe('narrow');
    // Order of the rows must not matter.
    expect(resolvePolicy([narrow, broad], ctx()).policy?.id).toBe('narrow');
  });

  it('ranks one narrow field above any number of broad ones', () => {
    /*
      The weighting exists for this. A rule naming only the climate type must outrank one
      naming country + region + district + city, or precedence becomes "whoever filled in
      more boxes" — which is not a rule anybody can reason about.
    */
    const many = rule({
      id: 'many',
      region: 'Andhra Pradesh',
      district: 'Krishna',
      city: 'Vijayawada',
    });
    const one = rule({ id: 'one', climateType: 'AC' });
    expect(specificity(one)).toBeGreaterThan(specificity(many));
    expect(resolvePolicy([many, one], ctx({ district: 'Krishna' })).policy?.id).toBe('one');
  });

  it('REFUSES two equally specific rules rather than picking one', () => {
    /*
      Either would be defensible, so the choice would be an accident of row order — and the
      same cinema could then price differently between two deploys. Both references are
      named so somebody can go and supersede one.
    */
    const a = rule({ id: 'a', region: 'Andhra Pradesh', regulatoryReference: 'FIXTURE-A' });
    const b = rule({ id: 'b', region: 'Andhra Pradesh', regulatoryReference: 'FIXTURE-B' });
    const r = resolvePolicy([a, b], ctx());
    expect(r.status).toBe('POLICY_CONFIGURATION_ERROR');
    expect(r.explanation).toContain('FIXTURE-A');
    expect(r.explanation).toContain('FIXTURE-B');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('effective dating', () => {
  const older = rule({
    id: 'older',
    region: 'Andhra Pradesh',
    maintenanceChargeMinor: 700,
    maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: new Date('2026-10-01T00:00:00Z'),
  });
  const newer = rule({
    id: 'newer',
    region: 'Andhra Pradesh',
    maintenanceChargeMinor: 900,
    maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
    effectiveFrom: new Date('2026-10-01T00:00:00Z'),
  });

  it('picks the policy in force on the business date', () => {
    expect(
      resolvePolicy([older, newer], ctx({ at: new Date('2026-06-01T00:00:00Z') })).policy?.id,
    ).toBe('older');
    expect(
      resolvePolicy([older, newer], ctx({ at: new Date('2026-11-01T00:00:00Z') })).policy?.id,
    ).toBe('newer');
  });

  it('has no gap and no overlap at the boundary instant', () => {
    /*
      `effectiveFrom` inclusive, `effectiveTo` exclusive. At exactly 2026-10-01T00:00:00Z the
      old policy has ended and the new one has begun — one match, not two and not zero.
      Written as a test because the alternative convention produces an ambiguity error for
      every order placed in that one second, and nobody would find it until it happened.
    */
    const boundary = ctx({ at: new Date('2026-10-01T00:00:00Z') });
    const r = resolvePolicy([older, newer], boundary);
    expect(r.status).toBe('COMPLIANT');
    expect(r.policy?.id).toBe('newer');
  });

  it('finds nothing before any policy has come into force', () => {
    const r = resolvePolicy([older, newer], ctx({ at: new Date('2025-12-31T23:59:59Z') }));
    expect(r.status).toBe('POLICY_NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('the maintenance charge', () => {
  const added = (minor: number) =>
    rule({
      region: 'Andhra Pradesh',
      maintenanceChargeMinor: minor,
      maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
    });
  const included = (minor: number) =>
    rule({
      region: 'Andhra Pradesh',
      maintenanceChargeMinor: minor,
      maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE',
    });

  it('is charged once per ticket, not once per order', () => {
    // Fixture amount. Two seats is twice the charge.
    const effect = applyPolicy(resolvePolicy([added(700)], ctx()), 2);
    expect(effect.maintenanceMinor).toBe(1_400);
    expect(effect.maintenanceAddedMinor).toBe(1_400);
  });

  it('does not scale with the ticket price', () => {
    /*
      A cart of a cheap seat and an expensive one is two tickets and two charges. The amount
      is per HEAD, not per rupee — which is why the caller passes a count rather than a
      subtotal, and why nothing here ever sees a price.
    */
    const cheapAndDear = applyPolicy(resolvePolicy([added(700)], ctx()), 2);
    expect(cheapAndDear.maintenanceMinor).toBe(1_400);
  });

  it('does NOT move the total when the charge is inside the published price', () => {
    /*
      The double-charge this design exists to prevent. The amount is still DISCLOSED — an
      invoice has to state it — but it adds nothing, exactly as an inclusive tax does not.
    */
    const effect = applyPolicy(resolvePolicy([included(700)], ctx()), 2);
    expect(effect.maintenanceMinor).toBe(1_400);
    expect(effect.maintenanceAddedMinor).toBe(0);
  });

  it('is nothing at all when the policy says the charge does not apply', () => {
    const effect = applyPolicy(resolvePolicy([rule({ region: 'Andhra Pradesh' })], ctx()), 3);
    expect(effect.maintenanceMinor).toBe(0);
    expect(effect.maintenanceTreatment).toBe('NOT_APPLICABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('the online booking fee', () => {
  const withFee = (p: PolicyRow['onlineFeePolicy'], cap: number | null = null) =>
    resolvePolicy(
      [rule({ region: 'Andhra Pradesh', onlineFeePolicy: p, onlineFeeCapMinor: cap })],
      ctx(),
    );

  it('is unrestricted only when a policy says ALLOWED', () => {
    expect(applyPolicy(withFee('ALLOWED'), 1).maxOnlineFeeMinor).toBeNull();
  });

  it('is suppressed entirely when the position is unconfirmed', () => {
    /*
      The most important behaviour in this file. REQUIRES_APPROVAL means nobody has read the
      current order for this state, and the platform's own fee schedule is not evidence that
      charging it there is lawful. Charging nothing cannot overcharge anybody.
    */
    const r = withFee('REQUIRES_APPROVAL');
    expect(r.status).toBe('REQUIRES_APPROVAL');
    expect(applyPolicy(r, 1).maxOnlineFeeMinor).toBe(0);
  });

  it('still SELLS when the position is unconfirmed', () => {
    // Refusing to sell cinema tickets in a whole state because a fee schedule is unconfirmed
    // would be a bigger harm than the one being avoided.
    expect(withFee('REQUIRES_APPROVAL').policy).not.toBeNull();
  });

  it('is zero when prohibited or already inside the ticket price', () => {
    expect(applyPolicy(withFee('PROHIBITED'), 1).maxOnlineFeeMinor).toBe(0);
    expect(applyPolicy(withFee('INCLUDED_IN_TICKET_PRICE'), 1).maxOnlineFeeMinor).toBe(0);
  });

  it('honours a cap', () => {
    expect(applyPolicy(withFee('CAPPED', 2_500), 1).maxOnlineFeeMinor).toBe(2_500);
  });

  it('refuses a CAPPED policy that records no cap', () => {
    // An unlimited fee wearing a limit's name is worse than no policy, because it looks
    // configured. The database refuses this too; both, because either can be bypassed.
    const r = withFee('CAPPED', null);
    expect(r.status).toBe('POLICY_CONFIGURATION_ERROR');
    expect(applyPolicy(r, 1).maxOnlineFeeMinor).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('ticket price limits', () => {
  const capped = resolvePolicy(
    [rule({ region: 'Andhra Pradesh', ticketPriceMaxMinor: 15_000 })],
    ctx(),
  );

  it('permits a price exactly AT the ceiling', () => {
    // "Up to ₹150" includes ₹150. An off-by-one here rejects lawful prices, and an organizer
    // has no way to tell that from a bug.
    expect(checkTicketPrice(capped, 15_000).ok).toBe(true);
  });

  it('rejects one rupee over, and says which order it broke', () => {
    const r = checkTicketPrice(capped, 15_100);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('PRICE_EXCEEDS_LIMIT');
    expect(r.reason).toContain('FIXTURE-ORDER-1');
  });

  it('permits anything when the policy states no ceiling', () => {
    /*
      No ceiling recorded is NOT an assertion that none exists in law — it is the absence of
      one in configuration, which is why the columns are nullable rather than defaulted to a
      number somebody would then rely on.
    */
    const r = resolvePolicy([rule({ region: 'Andhra Pradesh' })], ctx());
    expect(checkTicketPrice(r, 999_999).ok).toBe(true);
  });

  it('never silently adjusts a price to fit', () => {
    // It reports; it does not correct. Repricing an organizer's ticket without telling them
    // would be worse than refusing it.
    const r = checkTicketPrice(capped, 20_000);
    expect(r.ok).toBe(false);
    expect(Object.keys(r)).not.toContain('adjustedPriceMinor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('explainability', () => {
  it('names the order, the version and what it matched on', () => {
    // "Your booking was refused" with no reason is unactionable, and a compliance question
    // six months from now asks exactly this.
    const r = resolvePolicy(
      [
        rule({
          region: 'Andhra Pradesh',
          climateType: 'AC',
          version: 3,
          regulatoryReference: 'FIXTURE-ORDER-9',
        }),
      ],
      ctx(),
    );
    expect(r.explanation).toContain('FIXTURE-ORDER-9');
    expect(r.explanation).toContain('v3');
    expect(r.explanation).toContain('Andhra Pradesh');
    expect(r.explanation).toContain('AC');
  });

  it('is deterministic for the same inputs', () => {
    // Two concurrent bookings on one show must resolve the same policy and the same numbers.
    const rows = [
      rule({
        region: 'Andhra Pradesh',
        maintenanceChargeMinor: 700,
        maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
      }),
    ];
    const a = applyPolicy(resolvePolicy(rows, ctx()), 2);
    const b = applyPolicy(resolvePolicy([...rows].reverse(), ctx()), 2);
    expect(a).toEqual(b);
  });
});
