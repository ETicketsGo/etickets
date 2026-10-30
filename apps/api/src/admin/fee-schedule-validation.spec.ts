import { previewSchedule, validateSchedule, type ScheduleBand } from './fee-schedule-validation';

/**
 * A whole draft schedule, checked before publish, and its fee preview from the real engine.
 * USD is the market the production report came from; INR is checked to stay as it is.
 */

let n = 0;
const band = (
  minMinor: number,
  maxMinor: number | null,
  over: Partial<ScheduleBand> = {},
): ScheduleBand => ({
  key: `k${++n}`,
  sourceId: null,
  minMinor,
  maxMinor,
  feeType: 'FLAT',
  feeMinor: 199,
  feePercentBps: null,
  minFeeMinor: null,
  maxFeeMinor: null,
  country: 'United States',
  region: '*',
  active: true,
  ...over,
});

const errors = (bands: ScheduleBand[], currency = 'USD') =>
  validateSchedule(currency, bands).issues.filter((i) => i.severity === 'error');

const SEEDED_USD = () => [
  band(0, 999, { feeMinor: 49 }),
  band(1_000, 2_499, { feeMinor: 99 }),
  band(2_500, 4_999, { feeMinor: 149 }),
  band(5_000, null, { feeMinor: 199 }),
];

describe('validateSchedule - USD cent boundaries', () => {
  it('$0.00 - $99.99 then $100.00 and above is whole', () => {
    const r = validateSchedule('USD', [band(0, 9_999), band(10_000, null)]);
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('a schedule that starts at $0.01 leaves $0.00 uncovered', () => {
    const [e] = errors([band(1, null)]);
    expect(e).toMatchObject({ code: 'GAP', fromMinor: 0, toMinor: 0 });
    expect(e.message).toContain('orders of exactly $0.00');
  });

  it('$99.99 and $100.00 in two bands is not an overlap; $100.00 in both is', () => {
    expect(errors([band(0, 9_999), band(10_000, null)])).toEqual([]);
    const [e] = errors([band(0, 10_000), band(10_000, null)]);
    expect(e).toMatchObject({ code: 'OVERLAP', fromMinor: 10_000, toMinor: 10_000 });
    expect(e.message).toContain('orders from $100.00 to $100.00');
  });

  it('the reorganisation that the one-band editor refused is a valid draft', () => {
    // "$100 and above" became "$1,000 and above", and "$100 - $999.99" was added.
    const r = validateSchedule('USD', [band(0, 9_999), band(10_000, 99_999), band(100_000, null)]);
    expect(r.valid).toBe(true);
  });

  it('its half-done state names the hole as $100.00 to $999.99', () => {
    const [e] = errors([band(0, 9_999), band(100_000, null)]);
    expect(e.code).toBe('GAP');
    expect(e.message).toBe(
      'In United States, orders from $100.00 to $999.99 have no band. Add a band or widen a neighbour to cover them.',
    );
  });
});

describe('validateSchedule - editing and removing bands', () => {
  it('removing the first band leaves $0.00 - $9.99 uncovered', () => {
    const [, ...rest] = SEEDED_USD();
    expect(errors(rest)[0].message).toContain('orders from $0.00 to $9.99');
  });

  it('removing a middle band names its range', () => {
    const s = SEEDED_USD();
    expect(errors([s[0], s[2], s[3]])[0].message).toContain('orders from $10.00 to $24.99');
  });

  it('removing the last band leaves "and above" uncovered', () => {
    const s = SEEDED_USD();
    expect(errors(s.slice(0, 3))[0].message).toContain('orders of $50.00 and above');
  });

  it('switching every band off leaves no band in the market', () => {
    const [e] = errors(SEEDED_USD().map((b) => ({ ...b, active: false })));
    expect(e.code).toBe('NO_BAND');
  });

  it('replacing several bands with one band from $0.00 is valid', () => {
    expect(validateSchedule('USD', [band(0, null)]).valid).toBe(true);
  });

  it('accepts each supported way of charging', () => {
    const r = validateSchedule('USD', [
      band(0, 999, { feeType: 'FLAT', feeMinor: 49 }),
      band(1_000, 4_999, { feeType: 'PERCENT', feeMinor: 0, feePercentBps: 500, minFeeMinor: 50 }),
      band(5_000, 9_999, { feeType: 'COMBINED', feeMinor: 25, feePercentBps: 300 }),
      band(10_000, null, { feeType: 'FIXED_PER_TICKET', feeMinor: 150, maxFeeMinor: 2_000 }),
    ]);
    expect(r.valid).toBe(true);
  });

  it('refuses a percentage band with no percentage, in the band editor own words', () => {
    const [e] = errors([band(0, null, { feeType: 'PERCENT', feePercentBps: null })]);
    expect(e.code).toBe('BAND_INVALID');
    expect(e.message).toContain('needs a percentage above 0%');
  });

  it('refuses an inverted band', () => {
    const [e] = errors([band(0, 9_999), band(10_000, 5_000), band(10_000, null)]);
    expect(e.code).toBe('BAND_INVALID');
  });

  it('refuses a USD band scoped to a market that sells in another currency', () => {
    const e = errors([band(0, null), band(0, null, { country: 'India' })]);
    expect(e.map((i) => i.code)).toContain('WRONG_MARKET');
  });

  it('allows a state band over the national schedule, and checks the state too', () => {
    const r = validateSchedule('USD', [
      band(0, null),
      band(0, 9_999, { region: 'California', feeMinor: 0 }),
    ]);
    expect(r.valid).toBe(true);
  });
});

describe('validateSchedule - INR stays as it is', () => {
  it('the seeded rupee schedule is valid, with its paise between bands shown as notes', () => {
    const inr = [
      band(0, 19_900, { country: 'India', feeMinor: 500 }),
      band(20_000, 49_900, { country: 'India', feeMinor: 1_000 }),
      band(50_000, 99_900, { country: 'India', feeMinor: 1_500 }),
      band(100_000, null, { country: 'India', feeMinor: 2_000 }),
    ];
    const r = validateSchedule('INR', inr);
    expect(r.valid).toBe(true);
    expect(r.issues.every((i) => i.severity === 'note')).toBe(true);
    expect(r.issues[0].message).toContain('₹199.01 to ₹199.99');
  });
});

describe('previewSchedule - the real fee engine, live beside draft', () => {
  const live = SEEDED_USD();

  it('a free order pays no booking fee under either schedule', () => {
    const { rows } = previewSchedule('USD', [band(0, null, { feeMinor: 300 })], live);
    expect(rows.find((r) => r.orderMinor === 0)).toMatchObject({
      liveFeeMinor: 0,
      draftFeeMinor: 0,
    });
  });

  it('shows the draft fee next to the live one at each boundary', () => {
    const draft = [band(0, 9_999, { feeMinor: 99 }), band(10_000, null, { feeMinor: 299 })];
    const { place, rows } = previewSchedule('USD', draft, live);
    expect(place).toBe('United States');
    const at = (order: number, tickets = 1) =>
      rows.find((r) => r.orderMinor === order && r.tickets === tickets)!;
    expect(at(9_999)).toMatchObject({ liveFeeMinor: 199, draftFeeMinor: 99 });
    expect(at(10_000)).toMatchObject({ liveFeeMinor: 199, draftFeeMinor: 299 });
    expect(at(999)).toMatchObject({ liveFeeMinor: 49, draftFeeMinor: 99 });
  });

  it('prices a per-ticket band by the number of tickets', () => {
    const draft = [band(0, null, { feeType: 'FIXED_PER_TICKET', feeMinor: 150 })];
    const { rows } = previewSchedule('USD', draft, live);
    const at = (tickets: number) =>
      rows.find((r) => r.orderMinor === 10_000 && r.tickets === tickets)!;
    expect(at(1).draftFeeMinor).toBe(150);
    expect(at(4).draftFeeMinor).toBe(600);
  });
});
