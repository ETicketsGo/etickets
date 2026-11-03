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
