import {
  BillingUnit,
  CostSource,
  MICROS_PER_UNIT,
  OutcomeClass,
  costMicrosFor,
  countSmsSegments,
  isProviderOutcome,
  microsToDecimalString,
  reachedProvider,
} from '@eticketsgo/shared-types';

/**
 * Money, counted in whole numbers, and the difference between free and unknown.
 *
 * ── WHY MICROS ─────────────────────────────────────────────────────────────────────
 * SES is $0.10 per THOUSAND emails — a hundredth of a cent each. Every other price on this
 * platform is an integer number of cents, and in cents that email rounds to zero or to one:
 * one understates the bill to nothing, the other overstates it a hundredfold. Neither is a
 * rounding error, they are different answers to "can we afford this".
 */

describe('money is integers, and small ones', () => {
  it('prices an SES email exactly', () => {
    // $0.10 per 1,000 = 100 micro-USD each.
    expect(costMicrosFor(100_000, BillingUnit.PER_1000, 1)).toBe(100);
    expect(costMicrosFor(100_000, BillingUnit.PER_1000, 1000)).toBe(100_000);
    // …which is ten cents, not a tenth of a cent and not ten dollars.
    expect(microsToDecimalString(100_000, 2)).toBe('0.10');
  });

  it('divides once at the end rather than rounding every unit', () => {
    /*
      A hundred emails at $0.10/1000 is 10,000 micros exactly. Pricing each one first and
      summing would round a hundred times, and the error compounds over a month.
    */
    expect(costMicrosFor(100_000, BillingUnit.PER_1000, 100)).toBe(10_000);
  });

  it('multiplies per segment', () => {
    expect(costMicrosFor(7_900, BillingUnit.PER_SEGMENT, 3)).toBe(23_700);
  });

  it('never returns a float', () => {
    for (const [price, unit, qty] of [
      [7_900, BillingUnit.PER_SEGMENT, 3],
      [100_000, BillingUnit.PER_1000, 7],
      [150_000, BillingUnit.PER_MESSAGE, 1],
    ] as const) {
      expect(Number.isInteger(costMicrosFor(price, unit, qty))).toBe(true);
    }
  });

  it('renders micros back to a decimal without arithmetic', () => {
    expect(microsToDecimalString(MICROS_PER_UNIT)).toBe('1.000000');
    expect(microsToDecimalString(1_234_567, 4)).toBe('1.2345');
    expect(microsToDecimalString(0, 2)).toBe('0.00');
  });
});

describe('one logical SMS is not one billed SMS', () => {
  it('counts a short Latin message as one segment', () => {
    const r = countSmsSegments('Your booking ETG-IN-2026-0042 is confirmed.');
    expect(r).toMatchObject({ encoding: 'GSM7', segments: 1 });
  });

  it('counts a 200-character message as two', () => {
    // The mistake that makes a platform under-bill itself by half on long messages.
    expect(countSmsSegments('a'.repeat(200)).segments).toBe(2);
    expect(countSmsSegments('a'.repeat(160)).segments).toBe(1);
    // A concatenated message spends 7 characters per part on its reassembly header.
    expect(countSmsSegments('a'.repeat(161)).segments).toBe(2);
    expect(countSmsSegments('a'.repeat(306)).segments).toBe(2);
    expect(countSmsSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('charges two characters for a GSM-7 extension character', () => {
    // `{`, `}`, `[`, `]`, `~`, `^`, `\`, `|` and `€` each cost an escape plus themselves.
    expect(countSmsSegments('a'.repeat(159) + '€').units).toBe(161);
    expect(countSmsSegments('a'.repeat(159) + '€').segments).toBe(2);
  });

  it('drops the WHOLE message to Unicode for one non-GSM character', () => {
    /*
      The rule that surprises people, and the one that matters most here: an Indian
      transactional template with a rupee sign is Unicode, so its segment size falls from 160
      to 70 and a message that looked like one charge is three.
    */
    const rupee = countSmsSegments('Your refund of ₹500 has been processed.');
    expect(rupee.encoding).toBe('UCS2');
    expect(rupee.segments).toBe(1);

    const long = countSmsSegments('₹' + 'a'.repeat(150));
    expect(long.encoding).toBe('UCS2');
    expect(long.segments).toBe(3);
  });

  it('counts an emoji as the two code units it occupies', () => {
    // Counting code points would under-count every message containing one.
    expect(countSmsSegments('🎬'.repeat(35)).segments).toBe(1);
    expect(countSmsSegments('🎬'.repeat(36)).segments).toBe(2);
  });

  it('never returns zero segments', () => {
    expect(countSmsSegments('').segments).toBe(1);
  });
});

describe('whose failure was it', () => {
  it('counts only the provider’s outcomes against the provider', () => {
    expect(isProviderOutcome(OutcomeClass.PROVIDER_ACCEPTED)).toBe(true);
    expect(isProviderOutcome(OutcomeClass.PROVIDER_REJECTED)).toBe(true);
    expect(isProviderOutcome(OutcomeClass.PROVIDER_UNAVAILABLE)).toBe(true);
    expect(isProviderOutcome(OutcomeClass.UNDELIVERABLE_DESTINATION)).toBe(true);
  });

  it('does NOT count our own decisions against the provider', () => {
    /*
      A suppressed address and somebody with no phone number are ours. Counting them as
      "Twilio failed" makes Twilio look broken in proportion to how many of our customers
      have preferences — and hides a real outage inside a number that is always high.
    */
    expect(isProviderOutcome(OutcomeClass.POLICY_SUPPRESSED)).toBe(false);
    expect(isProviderOutcome(OutcomeClass.NO_DESTINATION)).toBe(false);
    expect(isProviderOutcome(null)).toBe(false);
  });

  it('knows which outcomes could possibly have cost money', () => {
    // A provider that was never called cannot have charged.
    expect(reachedProvider(OutcomeClass.PROVIDER_ACCEPTED)).toBe(true);
    expect(reachedProvider(OutcomeClass.UNDELIVERABLE_DESTINATION)).toBe(true);
    expect(reachedProvider(OutcomeClass.POLICY_SUPPRESSED)).toBe(false);
    expect(reachedProvider(OutcomeClass.NO_DESTINATION)).toBe(false);
    expect(reachedProvider(OutcomeClass.PROVIDER_UNAVAILABLE)).toBe(false);
  });
});

describe('free and unknown are different facts', () => {
  it('has a distinct source for each', () => {
    /*
      Both leave a total unchanged and they mean opposite things: one says the number on the
      screen is complete, the other says it is missing a component. A report that shows both
      as 0 is lying about one of them.
    */
    expect(CostSource.CONFIGURED_FREE).not.toBe(CostSource.UNKNOWN);
  });
});
