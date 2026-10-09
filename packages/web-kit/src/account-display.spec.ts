import { describe, expect, it } from 'vitest';
import {
  accountContact,
  accountInitials,
  accountName,
  formatPhoneForDisplay,
} from './account-display';

/*
  A phone-only account (signed in with an SMS code, no name, no email) was shown as
  "phone+14695884580@users.eticketsgo.internal" with the initials "PH". These pin what it is
  shown as instead.
*/
const phoneOnly = { fullName: '', email: null, phone: '+14695884580' };

describe('account display', () => {
  it('names a phone-only account by its own number, never a placeholder', () => {
    expect(accountName(phoneOnly)).toBe('+1 469-588-4580');
    expect(accountContact(phoneOnly)).toBeNull(); // not the same number twice
    expect(accountInitials(phoneOnly)).toBeNull(); // a generic avatar, not "PH"
  });

  it('uses the name once there is one, with the number as the contact line', () => {
    const named = { ...phoneOnly, fullName: 'Srinivas Rao' };
    expect(accountName(named)).toBe('Srinivas Rao');
    expect(accountContact(named)).toBe('+1 469-588-4580');
    expect(accountInitials(named)).toBe('SR');
  });

  it('keeps email accounts as they were', () => {
    const emailUser = { fullName: 'Owner Olive', email: 'olive@example.com', phone: null };
    expect(accountName(emailUser)).toBe('Owner Olive');
    expect(accountContact(emailUser)).toBe('olive@example.com');
    expect(accountInitials(emailUser)).toBe('OO');
  });

  it('formats Indian numbers the Indian way and leaves others in E.164', () => {
    expect(formatPhoneForDisplay('+919876543210')).toBe('+91 98765 43210');
    expect(formatPhoneForDisplay('+447700900123')).toBe('+447700900123');
    expect(formatPhoneForDisplay(null)).toBeNull();
  });
});
