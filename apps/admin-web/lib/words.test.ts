import { describe, expect, it } from 'vitest';
import { feeModeWords, plainWords, roleWords, statusWords } from './words';
import { DUTY_WORDS, dutyLabel, dutyWhat } from './duty-words';
import { ALL_ADMIN_PERMISSIONS } from '@eticketsgo/shared-types';

describe('codes in words', () => {
  it('reads a status code as words, not capitals', () => {
    expect(statusWords('UNDER_REVIEW')).toBe('Under review');
    expect(statusWords('PARTIALLY_REFUNDED')).toBe('Partly refunded');
    expect(statusWords('APPROVED')).toBe('Approved');
    expect(statusWords('SOME_NEW_STATE')).toBe('Some new state');
  });

  it('never rewrites text that is not a code', () => {
    expect(plainWords('Sole proprietorship')).toBe('Sole proprietorship');
    expect(plainWords('McDonald Live')).toBe('McDonald Live');
    expect(plainWords('')).toBe('');
    expect(plainWords(null)).toBe('');
  });

  it('names roles and fee handling the way a person would', () => {
    expect(roleWords('ORGANIZER_OWNER')).toBe('Organizer owner');
    expect(roleWords('CHECKIN_STAFF')).toBe('Check-in staff');
    expect(feeModeWords('CUSTOMER_PAYS')).toBe('The buyer pays the fees');
  });
});

describe('back-office duties', () => {
  it('names and explains every duty the API has, so none is a bare code', () => {
    for (const permission of ALL_ADMIN_PERMISSIONS) {
      expect(DUTY_WORDS[permission]).toBeDefined();
      expect(dutyWhat(permission)).toBeTruthy();
      expect(dutyLabel(permission)).not.toMatch(/_/);
    }
  });

  it('still reads a duty it does not know yet as words', () => {
    expect(dutyLabel('SOMETHING_NEW')).toBe('Something new');
    expect(dutyWhat('SOMETHING_NEW')).toBeNull();
  });
});
