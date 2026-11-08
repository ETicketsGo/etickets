import { describe, expect, it } from 'vitest';
import { firstVisitCountry } from './first-visit-location';

const h = (init: Record<string, string>) => new Headers(init);

describe('firstVisitCountry', () => {
  it('uses a trusted edge country header, as the API scopes to it', () => {
    expect(firstVisitCountry(h({ 'cf-ipcountry': 'in' }))).toBe('IN');
    expect(firstVisitCountry(h({ 'x-vercel-ip-country': 'US' }))).toBe('US');
  });

  it('makes no guess from the language or the client address', () => {
    expect(
      firstVisitCountry(h({ 'accept-language': 'en-US,en;q=0.9', 'x-forwarded-for': '1.2.3.4' })),
    ).toBeNull();
  });

  it('ignores the "could not tell" codes and anything that is not a country', () => {
    expect(firstVisitCountry(h({ 'cf-ipcountry': 'XX' }))).toBeNull();
    expect(firstVisitCountry(h({ 'cf-ipcountry': 'T1' }))).toBeNull();
    expect(firstVisitCountry(h({ 'cf-ipcountry': 'India' }))).toBeNull();
  });

  it('leaves an edge city to the browser: the API may map it to another country', () => {
    expect(firstVisitCountry(h({ 'cf-ipcountry': 'PK', 'cf-ipcity': 'Hyderabad' }))).toBeNull();
  });
});

describe('firstVisitCountry: the network-address fallback', () => {
  const lookups: string[] = [];
  const onRailway = {
    trustRealIp: true,
    countryFor: (ip: string) => {
      lookups.push(ip);
      return ip === '49.36.8.9' ? 'IN' : ip === '24.117.1.2' ? 'us' : null;
    },
  };

  it("draws the visitor's address country when no edge header says otherwise", () => {
    expect(firstVisitCountry(h({ 'x-real-ip': '49.36.8.9' }), onRailway)).toBe('IN');
    expect(firstVisitCountry(h({ 'x-real-ip': '24.117.1.2' }), onRailway)).toBe('US');
  });

  it('lets an edge header win over the address', () => {
    expect(
      firstVisitCountry(h({ 'cf-ipcountry': 'CA', 'x-real-ip': '49.36.8.9' }), onRailway),
    ).toBe('CA');
    expect(
      firstVisitCountry(h({ 'cf-ipcity': 'Pune', 'x-real-ip': '49.36.8.9' }), onRailway),
    ).toBeNull();
  });

  it('never reads x-real-ip where no trusted edge sets it', () => {
    lookups.length = 0;
    expect(
      firstVisitCountry(h({ 'x-real-ip': '49.36.8.9' }), { ...onRailway, trustRealIp: false }),
    ).toBeNull();
    expect(firstVisitCountry(h({ 'x-real-ip': '49.36.8.9' }))).toBeNull();
    expect(lookups).toEqual([]);
  });

  it('never reads X-Forwarded-For, and ignores a list or an unknown address', () => {
    expect(firstVisitCountry(h({ 'x-forwarded-for': '49.36.8.9' }), onRailway)).toBeNull();
    expect(firstVisitCountry(h({ 'x-real-ip': '49.36.8.9, 24.117.1.2' }), onRailway)).toBeNull();
    expect(firstVisitCountry(h({ 'x-real-ip': '10.0.0.1' }), onRailway)).toBeNull();
  });
});
