import { describe, expect, it } from 'vitest';
import { adminContact, phoneFromPlaceholderEmail } from './account-display';
import { countryDisplay, countryFilterOptions, parseCountryParam } from './country-display';

/*
  The admin console reads stored rows, so a phone-only account reaches it as its placeholder
  address. These pin that it is never shown as one.
*/
describe('admin contact line', () => {
  it('shows a real email address as it is', () => {
    expect(adminContact('ada@example.com')).toEqual({
      text: 'ada@example.com',
      phoneSignIn: false,
    });
  });

  it('shows a placeholder as the phone number it was made from, flagged', () => {
    expect(adminContact('phone+14695884580@users.eticketsgo.internal')).toEqual({
      text: '+1 469-588-4580',
      phoneSignIn: true,
    });
    expect(adminContact('PHONE+919876543210@USERS.ETICKETSGO.INTERNAL')).toEqual({
      text: '+91 98765 43210',
      phoneSignIn: true,
    });
  });

  it('prefers the stored number when the response carries it', () => {
    expect(adminContact('phone+14695884580@users.eticketsgo.internal', '+14695884580')).toEqual({
      text: '+1 469-588-4580',
      phoneSignIn: true,
    });
  });

  it('never returns the placeholder, even when it cannot be read', () => {
    const contact = adminContact('weird@users.eticketsgo.internal');
    expect(contact).toBeNull();
  });

  it('has nothing to show for nothing', () => {
    expect(adminContact(null)).toBeNull();
    expect(adminContact('')).toBeNull();
  });

  it('reads the number out of a placeholder only', () => {
    expect(phoneFromPlaceholderEmail('phone+14695884580@users.eticketsgo.internal')).toBe(
      '+14695884580',
    );
    // A real address that happens to look like one is somebody's mailbox, not a phone number.
    expect(phoneFromPlaceholderEmail('phone+14695884580@gmail.com')).toBeNull();
  });
});

describe('admin country display', () => {
  it('names every stored spelling of a market by its code and name', () => {
    for (const stored of ['India', 'india', 'IN', ' in ']) {
      expect(countryDisplay(stored)).toEqual({ code: 'IN', name: 'India' });
    }
    expect(countryDisplay('USA')).toEqual({ code: 'US', name: 'United States' });
  });

  it('shows an unknown country as stored, without inventing a code', () => {
    expect(countryDisplay('Atlantis')).toEqual({ code: null, name: 'Atlantis' });
  });

  it('has nothing for nothing', () => {
    expect(countryDisplay(null)).toBeNull();
    expect(countryDisplay('  ')).toBeNull();
  });

  it('offers the configured markets, by code', () => {
    const options = countryFilterOptions();
    expect(options.map((o) => o.code)).toEqual(expect.arrayContaining(['IN', 'US', 'CA']));
    expect(new Set(options.map((o) => o.code)).size).toBe(options.length);
  });

  it('passes on a 2-letter code from a link and drops anything else', () => {
    expect(parseCountryParam('in')).toBe('IN');
    expect(parseCountryParam('US')).toBe('US');
    expect(parseCountryParam('India')).toBeUndefined();
    expect(parseCountryParam('')).toBeUndefined();
    expect(parseCountryParam(null)).toBeUndefined();
  });
});
