import { describe, expect, it } from 'vitest';
import {
  aboveClassLimit,
  bookingFeeWording,
  classHasNoRate,
  classOptionLabel,
  classRateLines,
  classificationMatters,
  groupPrices,
  orderReference,
  classificationSummary,
  complianceHeadline,
  missingRateWarning,
  splitPrices,
} from './compliance-presentation';

const view = {
  summary: 'Cannot publish - Old test is priced at Rs 151.',
  status: 'COMPLIANT' as const,
  blocksPublishing: true,
};
const unmapped = {
  section: 'SALES',
  code: 'SALE_SEAT_CLASS_UNMAPPED',
  level: 'BLOCKED' as const,
  message: 'Platinum Executive has no regulatory class (2 of 4 upcoming shows).',
  fixPath: '#seat-classes',
};

describe('complianceHeadline', () => {
  it('leads with the current upcoming-show blocker, not the old test ticket', () => {
    const h = complianceHeadline(view, [unmapped]);
    expect(h.text).toContain('Platinum Executive');
    expect(h.text).not.toContain('151');
    expect(h.tone).toBe('error');
    expect(h.more).toBe(0);
  });
  it('counts the further blockers behind the lead', () => {
    expect(complianceHeadline(view, [unmapped, { ...unmapped, code: 'SALE_X' }]).more).toBe(1);
  });
  it('ignores warnings and other sections', () => {
    const h = complianceHeadline(view, [
      { ...unmapped, level: 'WARNING' },
      { ...unmapped, section: 'FEES' },
    ]);
    expect(h.text).toBe(view.summary);
  });
  it('falls back to the server summary and keeps review amber', () => {
    const review = { ...view, status: 'REQUIRES_APPROVAL' as const, blocksPublishing: false };
    expect(complianceHeadline(review, []).tone).toBe('warning');
    expect(complianceHeadline({ ...view, blocksPublishing: false }, undefined).tone).toBe(
      'success',
    );
  });
});

describe('splitPrices', () => {
  it('separates finished-show prices as history; absent flag counts as current', () => {
    const r = splitPrices([{ upcoming: true }, { upcoming: false }, {}]);
    expect(r.current).toHaveLength(2);
    expect(r.history).toHaveLength(1);
  });
});

describe('bookingFeeWording', () => {
  const money = (m: number) => `Rs ${m / 100}`;
  it('says the fee is held at 0 when no rule resolves', () => {
    const t = bookingFeeWording({ policy: 'UNRESOLVED', description: 'x', maxMinor: 0 }, money);
    expect(t).toMatch(/holds the booking fee at 0 until the rule is configured/);
    expect(t).not.toMatch(/may be charged/);
  });
  it('states a held-at-zero rule, an open schedule and a cap', () => {
    const prohibited = { policy: 'PROHIBITED', description: 'None.', maxMinor: 0 };
    expect(bookingFeeWording(prohibited, money)).toMatch(/^Checkout holds the booking fee at 0/);
    expect(
      bookingFeeWording({ policy: 'ALLOWED', description: 'x', maxMinor: null }, money),
    ).toMatch(/normal platform booking fee/);
    expect(
      bookingFeeWording({ policy: 'CAPPED', description: 'x', maxMinor: 500 }, money),
    ).toContain('Rs 5');
  });
  it('uses the server description from an older API', () => {
    expect(bookingFeeWording({ policy: 'ALLOWED', description: 'Server words.' }, money)).toBe(
      'Server words.',
    );
  });
});

describe('missing rate warning', () => {
  const rates = { REGULAR: true, RECLINER: true, PREMIUM: false, NON_PREMIUM: false };
  it('warns when the selected class has no rate row', () => {
    expect(
      missingRateWarning({ name: 'Gold', regulatoryClass: 'PREMIUM', classHasRate: rates }),
    ).toMatch(/no Premium rate/);
  });
  it('is silent for a covered, unmapped or unknown class', () => {
    const base = { name: 'G', classHasRate: rates };
    expect(missingRateWarning({ ...base, regulatoryClass: 'REGULAR' })).toBeNull();
    expect(missingRateWarning({ ...base, regulatoryClass: null })).toBeNull();
    expect(missingRateWarning({ name: 'G', regulatoryClass: 'PREMIUM' })).toBeNull();
    expect(classHasNoRate(rates, 'NON_PREMIUM')).toBe(true);
    expect(classHasNoRate(undefined, 'NON_PREMIUM')).toBe(false);
  });
});

describe('classificationSummary (F3)', () => {
  const invalid = {
    status: 'INVALID_CINEMA_CLASSIFICATION' as const,
    jurisdiction: {
      country: 'India',
      region: 'Andhra Pradesh',
      district: 'NTR',
      city: 'Vijayawada',
      localBodyType: 'MUNICIPAL_CORPORATION',
    },
    classification: { cinemaFormat: 'MULTIPLEX', climateType: 'AC' },
  };

  it('lets a server that names the reason speak for itself', () => {
    // The newer API's summary names the unmapped seat category; the generic guess would hide it.
    expect(classificationSummary({ ...invalid, reasonCode: 'SEAT_CLASS_UNMAPPED' })).toBeNull();
    const h = complianceHeadline(
      {
        ...invalid,
        reasonCode: 'SEAT_CLASS_UNMAPPED',
        blocksPublishing: true,
        summary: 'Cannot publish: seat category "Platinum Executive" has no regulatory seat class.',
      },
      [],
    );
    expect(h.text).toContain('Platinum Executive');
    expect(h.tone).toBe('error');
  });

  it('does not tell a classified cinema to set its classification', () => {
    const text = classificationSummary(invalid);
    expect(text).toContain('seat class');
    expect(text).not.toContain('Set its local body');
  });

  it('keeps the server sentence when a classification field really is missing', () => {
    expect(
      classificationSummary({
        ...invalid,
        classification: { cinemaFormat: null, climateType: 'AC' },
      }),
    ).toBeNull();
  });

  it('says nothing for any other status', () => {
    expect(classificationSummary({ ...invalid, status: 'COMPLIANT' as const })).toBeNull();
  });

  it('is what the headline leads with when no readiness blocker is current', () => {
    const h = complianceHeadline(
      { ...invalid, summary: 'has not been classified', blocksPublishing: true },
      [],
    );
    expect(h.text).toContain('seat class');
    expect(h.tone).toBe('error');
  });
});

describe('limits by seat class (walk 2026-10-15)', () => {
  const inr = (m: number) => `Rs ${m / 100}`;
  const rate = (
    regulatoryClass: 'REGULAR' | 'RECLINER' | 'PREMIUM' | 'NON_PREMIUM',
    maxMinor: number | null,
    sellable = true,
  ) => ({
    regulatoryClass,
    regulated: true,
    sellable,
    maxMinor,
    minMinor: null,
    regulatoryReference: sellable ? 'G.O.Ms.No.13' : null,
    status: 'REQUIRES_APPROVAL',
  });
  const AP = [
    rate('REGULAR', 15000),
    rate('RECLINER', 25000),
    rate('PREMIUM', null, false),
    rate('NON_PREMIUM', null, false),
  ];

  it('names the order from the classes when the room has several', () => {
    expect(
      orderReference({
        regulatoryReference: null,
        status: 'INVALID_CINEMA_CLASSIFICATION',
        classRates: AP,
      }),
    ).toBe('G.O.Ms.No.13');
    expect(
      orderReference({ regulatoryReference: null, status: 'NOT_REGULATED', classRates: [] }),
    ).toBe('None applies');
  });

  it('says Telangana has no rules yet, rather than "None applies"', () => {
    expect(
      orderReference({
        regulatoryReference: null,
        status: 'POLICY_NOT_FOUND',
        jurisdiction: {
          country: 'India',
          region: 'Telangana',
          district: null,
          city: 'Hyderabad',
          localBodyType: null,
        },
      }),
    ).toMatch(/No pricing rules on record for Telangana yet/);
  });

  it('lists every class with its limit', () => {
    expect(classRateLines(AP, inr).map((l) => `${l.label}: ${l.text}`)).toEqual([
      'Regular: Up to Rs 150',
      'Recliner: Up to Rs 250',
      'Premium: No rate here, so it cannot be sold online',
      'Non-premium: No rate here, so it cannot be sold online',
    ]);
    expect(classRateLines([], inr)).toEqual([]);
  });

  it('asks for the cinema type only where an order prices by it', () => {
    const unclassified = AP.map((r) => ({
      ...r,
      sellable: false,
      maxMinor: null,
      status: 'INVALID_CINEMA_CLASSIFICATION',
    }));
    expect(
      classificationMatters({ status: 'INVALID_CINEMA_CLASSIFICATION', classRates: unclassified }),
    ).toBe(true);
    // Classified and priced: nothing to ask.
    expect(classificationMatters({ status: 'INVALID_CINEMA_CLASSIFICATION', classRates: AP })).toBe(
      false,
    );
    // Telangana: no rules, so the type would change nothing - even with an unmapped seat.
    const telangana = AP.map((r) => ({ ...r, sellable: false, status: 'POLICY_NOT_FOUND' }));
    expect(
      classificationMatters({ status: 'INVALID_CINEMA_CLASSIFICATION', classRates: telangana }),
    ).toBe(false);
    expect(classificationMatters({ status: 'NOT_REGULATED', classRates: [] })).toBe(false);
  });

  it('says Telangana has no rules even when an unmapped seat hides it', () => {
    const telangana = AP.map((r) => ({
      ...r,
      sellable: false,
      regulatoryReference: null,
      status: 'POLICY_NOT_FOUND',
    }));
    expect(
      orderReference({
        regulatoryReference: null,
        status: 'INVALID_CINEMA_CLASSIFICATION',
        classRates: telangana,
        jurisdiction: {
          country: 'India',
          region: 'Telangana',
          district: null,
          city: 'Hyderabad',
          localBodyType: null,
        },
      }),
    ).toMatch(/No pricing rules on record for Telangana yet/);
  });

  it('groups the same price across shows into one line with a count', () => {
    const p = (name: string, priceMinor: number, ok = true) => ({
      name,
      priceMinor,
      ok,
      reason: ok ? null : 'over',
    });
    const groups = groupPrices([
      p('Regular', 15000),
      p('Regular', 15000),
      p('Recliner', 30000, false),
      p('Regular', 15000),
    ]);
    expect(groups.map((g) => [g.name, g.priceMinor, g.shows])).toEqual([
      ['Recliner', 30000, 1],
      ['Regular', 15000, 3],
    ]);
  });

  it('puts the limit on each class option', () => {
    expect(classOptionLabel('REGULAR', AP, inr)).toBe('Regular - up to Rs 150');
    expect(classOptionLabel('PREMIUM', AP, inr)).toBe('Premium - no rate here, will not sell');
    expect(classOptionLabel('REGULAR', [], inr)).toBe('Regular');
  });

  it('warns when a category is priced above the class it is mapped to', () => {
    const plat = { name: 'Platinum Executive', basePriceMinor: 20000, classRates: AP };
    expect(aboveClassLimit({ ...plat, regulatoryClass: 'REGULAR' }, inr)).toMatch(
      /Platinum Executive is priced at Rs 200, above the Rs 150 limit for a Regular seat/,
    );
    expect(aboveClassLimit({ ...plat, regulatoryClass: 'RECLINER' }, inr)).toBeNull();
    expect(aboveClassLimit({ ...plat, regulatoryClass: null }, inr)).toBeNull();
  });
});
