import { describe, expect, it } from 'vitest';
import { looksLikeTicketNumber } from './ticket-number';

describe('looksLikeTicketNumber', () => {
  it('knows the numbers printed on a ticket, however they are typed', () => {
    expect(looksLikeTicketNumber('TKT-E64E94E2ED41')).toBe(true);
    expect(looksLikeTicketNumber(' tkt-e64e94e2ed41 ')).toBe(true);
    expect(looksLikeTicketNumber('ETG-IND-2026-000047')).toBe(true);
  });

  it('leaves a QR reading to the scanner', () => {
    // A real reading: base64 JSON with a signature. It must still be verified, never looked up.
    expect(looksLikeTicketNumber('eyJ0aWNrZXRJZCI6ImNtdjliMGFibzAwZHNr')).toBe(false);
    expect(looksLikeTicketNumber('')).toBe(false);
    expect(looksLikeTicketNumber('TKT-')).toBe(false);
  });
});
