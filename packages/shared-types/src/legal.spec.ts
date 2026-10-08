import { describe, it, expect } from 'vitest';
import {
  LEGAL_ENTITIES,
  PLATFORM_OPERATOR,
  POLICY_REGISTRY,
  getApplicablePolicy,
  legalEntityFor,
  policyFromLabel,
  policyJurisdictionFor,
  policyVersionLabel,
  type PolicyType,
} from './legal';

describe('the operating entity', () => {
  it('names the registered entity for each market we are incorporated in', () => {
    expect(legalEntityFor('US').legalName).toBe('DeepTrics LLC');
    expect(legalEntityFor('IN').legalName).toBe('Deeptrics Software Solution Pvt Ltd');
  });

  it('accepts a country name as well as a code, because callers hold both', () => {
    // `Venue.country` stores a name; a market selector holds a code. Neither should have to
    // convert before asking who the counterparty is.
    expect(legalEntityFor('India')).toEqual(LEGAL_ENTITIES.IN);
    expect(legalEntityFor('United States')).toEqual(LEGAL_ENTITIES.US);
    expect(legalEntityFor('united states')).toEqual(LEGAL_ENTITIES.US);
  });

  it('falls back to the platform operator rather than to nothing', () => {
    /*
      Somebody is always the counterparty. Returning null here would put a page in the
      position of having to invent one, which is the failure this whole module exists to
      prevent.
    */
    expect(legalEntityFor('CA')).toEqual(PLATFORM_OPERATOR);
    expect(legalEntityFor(null)).toEqual(PLATFORM_OPERATOR);
    expect(legalEntityFor('')).toEqual(PLATFORM_OPERATOR);
    expect(legalEntityFor('Narnia')).toEqual(PLATFORM_OPERATOR);
  });
});

describe('jurisdiction resolution', () => {
  it('maps the markets that have their own supplements', () => {
    expect(policyJurisdictionFor('US')).toBe('US');
    expect(policyJurisdictionFor('india')).toBe('IN');
    expect(policyJurisdictionFor('Canada')).toBe('CA');
  });

  it('sends everything else to GLOBAL', () => {
    expect(policyJurisdictionFor('GB')).toBe('GLOBAL');
    expect(policyJurisdictionFor(undefined)).toBe('GLOBAL');
  });
});

describe('policy resolution', () => {
  const TYPES: PolicyType[] = ['TERMS', 'PRIVACY', 'SMS', 'REFUNDS', 'COOKIES'];

  it('EVERY type has a current GLOBAL version', () => {
    /*
      The invariant the fallback rests on. Without it, a market with no supplement resolves
      to nothing and a legal page renders empty - worse than showing text written for
      everybody. `getApplicablePolicy` throws rather than return undefined, so this test is
      what keeps that throw unreachable.
    */
    for (const type of TYPES) {
      const global = POLICY_REGISTRY.filter(
        (p) => p.type === type && p.jurisdiction === 'GLOBAL' && p.status === 'current',
      );
      expect(global, `${type} must have exactly one current GLOBAL policy`).toHaveLength(1);
    }
  });

  it('prefers a country supplement over the global text', () => {
    expect(getApplicablePolicy('TERMS', 'IN').jurisdiction).toBe('IN');
    expect(getApplicablePolicy('TERMS', 'CA').jurisdiction).toBe('CA');
  });

  it('falls back to GLOBAL where a market has no supplement', () => {
    // SMS has only a US supplement today; Canada must still resolve to readable terms.
    expect(getApplicablePolicy('SMS', 'CA').jurisdiction).toBe('GLOBAL');
    expect(getApplicablePolicy('REFUNDS', 'US').jurisdiction).toBe('GLOBAL');
    expect(getApplicablePolicy('COOKIES', 'IN').jurisdiction).toBe('GLOBAL');
  });

  it('never returns a superseded version', () => {
    for (const type of TYPES) {
      for (const c of ['US', 'IN', 'CA', 'GB', null]) {
        expect(getApplicablePolicy(type, c).status).toBe('current');
      }
    }
  });

  it('has at most one current version per type and jurisdiction', () => {
    const seen = new Map<string, number>();
    for (const p of POLICY_REGISTRY.filter((x) => x.status === 'current')) {
      const key = `${p.type}/${p.jurisdiction}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) expect(count, `${key} is ambiguous`).toBe(1);
  });

  it('never reuses a version number within a type and jurisdiction', () => {
    // Reuse would make a stored consent label ambiguous, which defeats the record.
    const seen = new Set<string>();
    for (const p of POLICY_REGISTRY) {
      const key = policyVersionLabel(p);
      expect(seen.has(key), `${key} appears twice`).toBe(false);
      seen.add(key);
    }
  });
});

describe('the label stored on a consent record', () => {
  it('round-trips', () => {
    const p = getApplicablePolicy('TERMS', 'IN');
    expect(policyVersionLabel(p)).toBe('TERMS/IN/v1');
    expect(policyFromLabel('TERMS/IN/v1')).toEqual(p);
  });

  it('is readable without joining anything', () => {
    // The point of a string rather than a foreign key: an audit export is legible as-is.
    expect(policyVersionLabel(getApplicablePolicy('SMS', 'US'))).toBe('SMS/US/v1');
  });

  it('answers null for a label it does not know, rather than guessing', () => {
    expect(policyFromLabel('TERMS/ZZ/v9')).toBeNull();
    expect(policyFromLabel('nonsense')).toBeNull();
  });
});
