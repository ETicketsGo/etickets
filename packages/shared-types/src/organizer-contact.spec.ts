import { describe, expect, it } from 'vitest';
import { issuesTaxInvoices } from './markets';
import {
  contactEmailProblem,
  contactNameProblem,
  phoneProblem,
  taxRegistrationNumberProblem,
  taxRegistrationTypes,
} from './organizer-contact';

describe('contact names', () => {
  it('accepts international names with spaces, hyphens, apostrophes and accents', () => {
    for (const ok of [
      'Anne-Marie',
      "O'Brien Ltd",
      'José Núñez',
      'Zoë Ålund',
      'राजेश कुमार',
      '李小龍先生',
      'Nguyễn Văn An',
    ]) {
      expect([ok, contactNameProblem(ok)]).toEqual([ok, null]);
    }
  });

  it('refuses names under five characters once trimmed, and blank is not its problem', () => {
    expect(contactNameProblem('A')).toMatch(/at least 5/);
    expect(contactNameProblem('  Abc  ')).toMatch(/at least 5/);
    expect(contactNameProblem('Zoë')).toMatch(/at least 5/);
    expect(contactNameProblem('')).toBeNull();
    expect(contactNameProblem('   ')).toBeNull();
  });

  it('refuses digits and symbols', () => {
    expect(contactNameProblem('Finance 123')).toMatch(/letters/);
    expect(contactNameProblem('-Anne Smith')).toMatch(/letters/);
    expect(contactNameProblem('anne@corp.com')).toMatch(/letters/);
  });
});

describe('contact emails', () => {
  it('accepts common and international addresses, trimmed', () => {
    for (const ok of [
      'finance@company.com',
      ' first.last+tag@sub.example.co.in ',
      "o'neil@corp.io",
      'info@bücher.de',
      'user@xn--bcher-kva.de',
      'संपर्क@उदाहरण.भारत',
    ]) {
      expect([ok, contactEmailProblem(ok)]).toEqual([ok, null]);
    }
  });

  it('refuses malformed addresses', () => {
    for (const bad of [
      'plain',
      'a@b',
      '@corp.com',
      'a@@corp.com',
      'a b@corp.com',
      'a@corp..com',
      '.a@corp.com',
      'a.@corp.com',
      'a@-corp.com',
      'a@corp.c0m',
    ]) {
      expect([bad, contactEmailProblem(bad)]).toEqual([bad, expect.stringMatching(/valid email/)]);
    }
    expect(contactEmailProblem('')).toBeNull();
  });
});

describe('phone numbers', () => {
  it('US: ten digits under the NANP rules', () => {
    expect(phoneProblem('+12085550100', { country: 'US' })).toBeNull();
    expect(phoneProblem('+1208555010', { country: 'US' })).toMatch(/10 digits/);
    expect(phoneProblem('+11085550100', { country: 'US' })).toMatch(/United States/);
  });

  it('India: ten digits, a mobile where one is required', () => {
    expect(phoneProblem('+919704464007')).toBeNull();
    expect(phoneProblem('+911123456789')).toBeNull();
    expect(phoneProblem('+911123456789', { mobileOnly: true })).toMatch(/mobile/);
    expect(phoneProblem('+9197044640071')).toMatch(/India/);
  });

  it('names the country and its length for a number that is too short (QA, 2026-11-05)', () => {
    expect(phoneProblem('+9112')).toMatch(/valid India number: 10 digits/);
    expect(phoneProblem('+1208', { country: 'US' })).toMatch(/valid United States number/);
  });

  it('is not ten digits everywhere', () => {
    expect(phoneProblem('+6581234567')).toBeNull();
    expect(phoneProblem('+447911123456')).toBeNull();
  });

  it('refuses letters, punctuation and over-long input', () => {
    expect(phoneProblem('+1208555CALL')).toMatch(/digits only/);
    expect(phoneProblem('+1 208 555 0100')).toMatch(/digits only/);
    expect(phoneProblem('+1208555010012345678')).toMatch(/too long/);
    expect(phoneProblem('')).toBeNull();
  });
});

describe('tax registrations', () => {
  it('offers EIN, state sales tax ID and not registered in the US; GSTIN, PAN and not GST registered in India', () => {
    expect(taxRegistrationTypes('United States')?.map((t) => t.kind)).toEqual([
      'EIN',
      'State sales tax ID',
      'Not registered',
    ]);
    expect(taxRegistrationTypes('IN')?.map((t) => t.kind)).toEqual([
      'GSTIN',
      'PAN',
      'Not GST registered',
    ]);
    expect(taxRegistrationTypes('Canada')).toBeNull();
  });

  it('checks each number against its own format', () => {
    expect(taxRegistrationNumberProblem('US', 'EIN', '12-3456789')).toBeNull();
    expect(taxRegistrationNumberProblem('US', 'EIN', '123456789')).toBeNull();
    expect(taxRegistrationNumberProblem('US', 'EIN', '12345689')).toMatch(/valid EIN/);
    expect(taxRegistrationNumberProblem('IN', 'GSTIN', '29AABCU9603R1ZM')).toBeNull();
    expect(taxRegistrationNumberProblem('IN', 'GSTIN', '29aabcu9603r1zm')).toBeNull();
    expect(taxRegistrationNumberProblem('IN', 'GSTIN', '29AABCU9603R1Z')).toMatch(/valid GSTIN/);
    expect(taxRegistrationNumberProblem('IN', 'PAN', 'ABCDE1234F')).toBeNull();
    expect(taxRegistrationNumberProblem('IN', 'PAN', 'ABCD1234F')).toMatch(/valid PAN/);
  });

  it('keeps a personal SSN or ITIN out', () => {
    expect(taxRegistrationNumberProblem('US', 'EIN', '123-45-6789')).toMatch(/SSN or ITIN/);
    expect(taxRegistrationNumberProblem('US', 'State sales tax ID', '912-70-1234')).toMatch(
      /SSN or ITIN/,
    );
  });

  it('"not registered" carries no number, and an unknown older kind is not judged', () => {
    expect(taxRegistrationNumberProblem('US', 'Not registered', '')).toBeNull();
    expect(taxRegistrationNumberProblem('US', 'Not registered', '12-3456789')).toMatch(
      /Remove the number/,
    );
    expect(taxRegistrationNumberProblem('Canada', 'GST/HST number', 'anything')).toBeNull();
    expect(taxRegistrationNumberProblem('IN', null, 'legacy-value')).toBeNull();
  });

  it('a PAN never makes a GST invoice; a GSTIN and an older blank kind still do; the US never does', () => {
    expect(issuesTaxInvoices('India', 'PAN')).toBe(false);
    expect(issuesTaxInvoices('India', 'GSTIN')).toBe(true);
    expect(issuesTaxInvoices('India', null)).toBe(true);
    expect(issuesTaxInvoices('United States', 'State sales tax ID')).toBe(false);
  });
});
