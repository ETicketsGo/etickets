import { describe, expect, it } from 'vitest';
import {
  isResidenceCountry,
  phoneCallingCode,
  phoneCallingCodeLabel,
  phoneSignInOutcome,
} from './phone-identity';

describe('phoneSignInOutcome', () => {
  it('reports an existing account on the sign-up form', () => {
    expect(phoneSignInOutcome('sign-up', false)).toBe('existing');
    expect(phoneSignInOutcome('sign-up', undefined)).toBe('existing');
  });
  it('reports a created account only when the API says so', () => {
    expect(phoneSignInOutcome('sign-up', true)).toBe('created');
  });
  it('announces nothing on the sign-in form', () => {
    expect(phoneSignInOutcome('sign-in', true)).toBe('signed-in');
    expect(phoneSignInOutcome('sign-in', false)).toBe('signed-in');
  });
});

describe('phoneCallingCode - a fact about the number', () => {
  it('reads IN, US and CA numbers', () => {
    expect(phoneCallingCode('+919876543210')).toBe('+91');
    expect(phoneCallingCode('+14695884580')).toBe('+1');
    expect(phoneCallingCode('+14167390000')).toBe('+1');
    expect(phoneCallingCode('+971501234567')).toBe('+971');
  });
  it('never guesses for an unknown code or a non-E.164 value', () => {
    expect(phoneCallingCode('+33612345678')).toBeNull();
    expect(phoneCallingCode('9876543210')).toBeNull();
    expect(phoneCallingCode('+91 98765 43210')).toBeNull();
    expect(phoneCallingCode(null)).toBeNull();
  });
  it('labels +1 as shared, never as one country', () => {
    expect(phoneCallingCodeLabel('+14695884580')).toBe('+1 (US/CA)');
    expect(phoneCallingCodeLabel('+919876543210')).toBe('+91 (IN)');
    expect(phoneCallingCodeLabel(undefined)).toBeNull();
  });
});

describe('isResidenceCountry', () => {
  it('accepts the markets and nothing else', () => {
    expect(isResidenceCountry('IN')).toBe(true);
    expect(isResidenceCountry('CA')).toBe(true);
    expect(isResidenceCountry('in')).toBe(false);
    expect(isResidenceCountry('ZZ')).toBe(false);
    expect(isResidenceCountry(null)).toBe(false);
  });
});
