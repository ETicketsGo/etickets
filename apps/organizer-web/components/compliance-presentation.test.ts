import { describe, expect, it } from 'vitest';
import {
  bookingFeeWording,
  classHasNoRate,
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
