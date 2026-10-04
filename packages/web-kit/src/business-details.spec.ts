import { describe, it, expect } from 'vitest';
import {
  BUSINESS_DETAILS,
  canReachSupport,
  missingBusinessDetails,
  needsPlaceholderNotice,
  publishedDetail,
  unreachableReason,
  type BusinessDetails,
} from './business-details';

/**
 * unit - the business facts the storefront is allowed to state.
 *
 * The defect these guard against shipped: a storefront that offered `support@eticketsgo.example`
 * to a paying customer. The addresses are gone; what these tests hold is the reason they cannot
 * come back, and the rule that the disclosure stays up until real ones exist.
 */

const FILLED: BusinessDetails = {
  legalName: 'A Real Company Pvt Ltd',
  supportEmail: 'help@a-real-domain.in',
  organizerEmail: 'organizers@a-real-domain.in',
  salesEmail: 'sales@a-real-domain.in',
  partnershipsEmail: 'partners@a-real-domain.in',
  mediaEmail: 'press@a-real-domain.in',
  supportPhone: '+91 40 1234 5678',
  postalAddress: '1 Somewhere Road, Hyderabad 500001, India',
  supportHours: 'Mon-Fri, 10:00-18:00 IST',
};

describe('nothing is published until somebody publishes it', () => {
  it('ships with every detail unset', () => {
    /*
      This is the assertion that fails if anybody invents a value to make a page look done.
      Filling one in is a legitimate act - it just has to be deliberate enough to update a test.
    */
    expect(missingBusinessDetails()).toEqual([
      'legalName',
      'supportEmail',
      'organizerEmail',
      'salesEmail',
      'partnershipsEmail',
      'mediaEmail',
      'supportPhone',
      'postalAddress',
      'supportHours',
    ]);
  });

  it('keeps the storefront notice up while anything is missing', () => {
    expect(needsPlaceholderNotice()).toBe(true);
  });

  it('takes the notice down by itself once everything is real', () => {
    // The disclosure is derived, so it cannot outlive the problem - nor be deleted before it.
    expect(needsPlaceholderNotice(FILLED)).toBe(false);
  });

  it('still shows the notice when only the inessential details are filled', () => {
    const partial: BusinessDetails = { ...FILLED, supportEmail: null };
    expect(needsPlaceholderNotice(partial)).toBe(true);
  });

  it('treats whitespace as unpublished', () => {
    expect(missingBusinessDetails({ ...FILLED, supportEmail: '   ' })).toEqual(['supportEmail']);
  });
});

describe('whether a customer could get help', () => {
  it('says no today, because they could not', () => {
    expect(canReachSupport()).toBe(false);
  });

  it('needs both who was paid and where to write', () => {
    expect(canReachSupport({ ...FILLED, legalName: null })).toBe(false);
    expect(canReachSupport({ ...FILLED, supportEmail: null })).toBe(false);
    expect(canReachSupport(FILLED)).toBe(true);
  });

  it('does not depend on the marketing addresses', () => {
    // A media contact is not what stands between a customer and their money.
    expect(canReachSupport({ ...FILLED, mediaEmail: null, partnershipsEmail: null })).toBe(true);
  });
});

describe('addresses that can never receive mail', () => {
  it('rejects every reserved domain from RFC 2606 and RFC 6761', () => {
    for (const addr of [
      'support@eticketsgo.example',
      'hello@eticketsgo.example',
      'organizers@eticketsgo.example',
      'a@b.test',
      'a@b.invalid',
      'a@localhost',
      'someone@example.com',
    ]) {
      expect(unreachableReason(addr), addr).not.toBeNull();
    }
  });

  it('rejects the placeholder shapes that shipped', () => {
    expect(unreachableReason('+00 0000 000000 (placeholder)')).not.toBeNull();
    expect(unreachableReason('Bengaluru, India (placeholder)')).not.toBeNull();
    expect(unreachableReason('TBD')).not.toBeNull();
  });

  it('accepts a real address', () => {
    expect(unreachableReason('help@eticketsgo.com')).toBeNull();
    expect(unreachableReason('+91 40 1234 5678')).toBeNull();
    // A real domain that merely contains the letters is not reserved.
    expect(unreachableReason('help@exampleevents.in')).toBeNull();
  });

  it('refuses to render one even if it reaches the committed file', () => {
    /*
      The guard sits in the render path, not only here. Someone pasting a `.example` address
      into BUSINESS_DETAILS gets a blank contact card rather than a promise that cannot be kept.
    */
    expect(publishedDetail('support@eticketsgo.example')).toBeNull();
    expect(publishedDetail('help@eticketsgo.com')).toBe('help@eticketsgo.com');
    expect(publishedDetail(null)).toBeNull();
    expect(publishedDetail('  ')).toBeNull();
  });
});

describe('the shipped file itself', () => {
  it('contains no undeliverable value', () => {
    // Belt and braces: whatever is in there, none of it may be a known-dead address.
    for (const [key, value] of Object.entries(BUSINESS_DETAILS)) {
      if (typeof value === 'string') {
        expect(unreachableReason(value), key).toBeNull();
      }
    }
  });
});
