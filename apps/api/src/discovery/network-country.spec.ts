import { networkCountry } from './network-country';

describe('networkCountry - the country an edge header names', () => {
  it('reads the trusted headers in order, upper-cased', () => {
    expect(networkCountry({ 'cf-ipcountry': 'in' })).toBe('IN');
    expect(networkCountry({ 'x-vercel-ip-country': 'US' })).toBe('US');
    expect(networkCountry({ 'cf-ipcountry': 'CA', 'x-vercel-ip-country': 'US' })).toBe('CA');
  });

  it('treats "could not tell" and junk as no country', () => {
    expect(networkCountry({ 'cf-ipcountry': 'XX' })).toBeNull();
    expect(networkCountry({ 'cf-ipcountry': 'T1' })).toBeNull();
    expect(networkCountry({ 'cf-ipcountry': 'India' })).toBeNull();
    expect(networkCountry({})).toBeNull();
  });

  it('ignores headers it does not trust', () => {
    expect(networkCountry({ 'x-country': 'IN' })).toBeNull();
  });
});
