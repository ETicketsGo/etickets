import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@eticketsgo/web-kit';
import { classifyGateFailure, classifyGateInput, isScanTerminator } from './gate-scan';

describe('classifyGateInput', () => {
  it('treats an empty or blank field as nothing to check', () => {
    expect(classifyGateInput('')).toEqual({ kind: 'empty' });
    expect(classifyGateInput('   \n')).toEqual({ kind: 'empty' });
  });

  it('sends a typed ticket number to the lookup, never to the scan endpoint', () => {
    expect(classifyGateInput(' tkt-1a2b3c ')).toEqual({ kind: 'number', value: 'TKT-1A2B3C' });
    expect(classifyGateInput('ETG-IND-2026-000002')).toEqual({
      kind: 'number',
      value: 'ETG-IND-2026-000002',
    });
  });

  it('sends a QR reading to the scan endpoint, trimmed (a scanner adds a newline)', () => {
    expect(classifyGateInput('eyJhbGciOi.payload.sig\n')).toEqual({
      kind: 'token',
      value: 'eyJhbGciOi.payload.sig',
    });
  });
});

describe('classifyGateFailure', () => {
  it('a request that never arrived is a connection problem, not a bad ticket', () => {
    expect(classifyGateFailure(new TypeError('Failed to fetch'))).toBe('NO_CONNECTION');
  });

  it('an error answer from the server means the ticket was not checked', () => {
    const forbidden = new ApiRequestError(
      'FORBIDDEN',
      'You cannot check in here.',
      undefined,
      undefined,
      403,
    );
    expect(classifyGateFailure(forbidden)).toBe('NOT_CHECKED');
    const fault = new ApiRequestError(
      'INTERNAL',
      'Something went wrong.',
      undefined,
      undefined,
      500,
    );
    expect(classifyGateFailure(fault)).toBe('NOT_CHECKED');
  });
});

describe('isScanTerminator', () => {
  it('a Tab after a scanned code submits it', () => {
    expect(isScanTerminator('Tab', 'eyJ.payload.sig')).toBe(true);
  });

  it('a Tab on an empty field is left to move focus', () => {
    expect(isScanTerminator('Tab', '')).toBe(false);
    expect(isScanTerminator('Tab', '   ')).toBe(false);
  });

  it('other keys are not terminators here (Enter is the form submit)', () => {
    expect(isScanTerminator('a', 'abc')).toBe(false);
    expect(isScanTerminator('Enter', 'abc')).toBe(false);
  });
});
