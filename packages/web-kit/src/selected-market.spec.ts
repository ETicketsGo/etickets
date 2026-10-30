import { describe, expect, it } from 'vitest';
import { selectedMarketFor } from './city';

/*
  The market a page may name a company for. "All cities" means every city in the CURRENT
  market, never both countries: it keeps the market the reader selected, while the page is
  still scoped to that country. A guess alone never selects one.
*/
const base = { chosen: true, city: null, place: null, country: null, remembered: null };
const india = { region: 'Telangana', country: 'India' };

describe('selectedMarketFor', () => {
  it('a chosen city selects its own country', () => {
    expect(selectedMarketFor({ ...base, city: 'Hyderabad', place: india })).toBe('IN');
    expect(
      selectedMarketFor({
        ...base,
        city: 'Austin',
        place: { region: 'Texas', country: 'United States' },
      }),
    ).toBe('US');
  });

  it('"All cities" in India keeps India, from storage or in this session', () => {
    for (const city of ['__all__', null]) {
      expect(selectedMarketFor({ ...base, city, country: 'IN', remembered: 'IN' })).toBe('IN');
    }
  });

  it('"All cities" with no market ever selected selects none', () => {
    expect(selectedMarketFor({ ...base, city: '__all__', country: 'IN' })).toBeNull();
  });

  it('"All cities" scoped to another country, or to nothing yet, selects none', () => {
    expect(
      selectedMarketFor({ ...base, city: '__all__', country: 'US', remembered: 'IN' }),
    ).toBeNull();
    expect(selectedMarketFor({ ...base, city: '__all__', remembered: 'IN' })).toBeNull();
  });

  it('nothing chosen selects nothing', () => {
    expect(
      selectedMarketFor({ ...base, chosen: false, city: 'Hyderabad', place: india }),
    ).toBeNull();
  });
});
