import { describe, it, expect } from 'vitest';
import { regionMatches, regionAliases, indiaState, INDIA_STATES } from '@eticketsgo/shared-types';

/**
 * Two spellings of one state must compare as one state.
 *
 * ── THE FAILURE THIS PREVENTS ──────────────────────────────────────────────────────
 * Whether an Indian order is CGST + SGST or IGST is one comparison: is the buyer's state the
 * supplier's state? Three different people fill in the three fields that feed it — an
 * organizer types a venue's region, someone types the organization's registered region at
 * onboarding, a buyer picks their state at checkout.
 *
 * Compared as raw strings, "TG", "36" and "Telangana" are three places. The failure is
 * silent and goes one way only: everything looks inter-state, so every rupee is attributed
 * to the wrong government — while the amount charged stays correct, the receipt looks
 * right, and nobody notices until a filing does.
 */
describe('one place, however it is written', () => {
  it('matches a GST code, an abbreviation and a full name to each other', () => {
    for (const [a, b] of [
      ['TG', 'Telangana'],
      ['36', 'TG'],
      ['36', 'Telangana'],
      ['telangana', 'TELANGANA'],
      ['Tamil Nadu', 'TN'],
      ['33', 'tamilnadu'],
    ]) {
      expect(regionMatches(a, b)).toBe(true);
    }
  });

  it('tolerates the punctuation and spacing people actually type', () => {
    expect(regionMatches('Jammu and Kashmir', 'jammu-and-kashmir')).toBe(true);
    expect(regionMatches('  Andhra Pradesh  ', 'AP')).toBe(true);
  });

  it('keeps genuinely different states apart', () => {
    // The half that matters in the other direction: a real inter-state sale must still read
    // as one, or IGST is never charged when it should be.
    expect(regionMatches('Telangana', 'Maharashtra')).toBe(false);
    expect(regionMatches('36', '27')).toBe(false);
    expect(regionMatches('AP', 'TG')).toBe(false);
  });

  it('treats a missing side as unknown, never as different', () => {
    /*
      Not knowing where somebody is is not evidence that they are somewhere else. `false`
      here means "do not treat this as crossing a border", which leaves the sale intra-state
      — the same answer the law reaches for a buyer with no address on record.
    */
    expect(regionMatches(null, 'Telangana')).toBe(false);
    expect(regionMatches('Telangana', undefined)).toBe(false);
    expect(regionMatches('', 'Telangana')).toBe(false);
    expect(regionMatches('   ', 'Telangana')).toBe(false);
  });

  it('does nothing outside India, where it has no business guessing', () => {
    // A region the table has never heard of compares only as itself. Canadian and US
    // provinces and states pass through untouched.
    expect(regionMatches('Ontario', 'Ontario')).toBe(true);
    expect(regionMatches('Ontario', 'Quebec')).toBe(false);
    expect(regionAliases('Ontario')).toEqual(['ontario']);
  });
});

describe('the list itself', () => {
  it('omits the two retired codes', () => {
    /*
      25 (Daman and Diu) and 28 (undivided Andhra Pradesh) were retired when their
      territories were reorganised. Offering a retired code as a choice invites somebody to
      pick it, and a GSTIN beginning with it is not issuable.
    */
    const codes = INDIA_STATES.map((s) => s.code);
    expect(codes).not.toContain('25');
    expect(codes).not.toContain('28');
    expect(codes).toContain('26');
    expect(codes).toContain('37');
  });

  it('has no duplicate code, abbreviation or name', () => {
    // A duplicate would make two states alias to each other, which is the exact bug this
    // file exists to prevent, arriving through the fix rather than around it.
    for (const key of ['code', 'abbr', 'name'] as const) {
      const values = INDIA_STATES.map((s) => s[key]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('resolves a canonical record from any spelling, for an invoice', () => {
    // A GST invoice names the place of supply. Whatever was typed, one name is printed.
    expect(indiaState('TG')?.name).toBe('Telangana');
    expect(indiaState('36')?.name).toBe('Telangana');
    expect(indiaState('telangana')?.code).toBe('36');
    expect(indiaState('Nowhere')).toBeNull();
    expect(indiaState(null)).toBeNull();
  });
});
