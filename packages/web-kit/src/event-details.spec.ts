import { describe, expect, it } from 'vitest';
import { showDurationMinutes, splitMinutes, termsList } from './event-details';

describe('showDurationMinutes', () => {
  it('is the span between a show start and end', () => {
    expect(showDurationMinutes('2026-09-27T15:00:00Z', '2026-09-27T16:30:00Z')).toBe(90);
  });

  it('is null when the end is not after the start', () => {
    expect(showDurationMinutes('2026-09-27T15:00:00Z', '2026-09-27T15:00:00Z')).toBeNull();
    expect(showDurationMinutes('2026-09-27T15:00:00Z', '2026-09-27T14:00:00Z')).toBeNull();
  });

  it('is null for a multi-day pass, which has a date range rather than a duration', () => {
    expect(showDurationMinutes('2026-10-02T10:00:00Z', '2026-10-04T22:00:00Z')).toBeNull();
  });

  it('splits into hours and minutes for display', () => {
    expect(splitMinutes(90)).toEqual({ hours: 1, minutes: 30 });
    expect(splitMinutes(75)).toEqual({ hours: 1, minutes: 15 });
    expect(splitMinutes(45)).toEqual({ hours: 0, minutes: 45 });
  });
});

describe('termsList', () => {
  it('makes one entry per line and drops blank lines', () => {
    expect(termsList('Tickets cannot be exchanged.\n\nArrive 30 minutes early.')).toEqual([
      'Tickets cannot be exchanged.',
      'Arrive 30 minutes early.',
    ]);
  });

  it('removes numbering the organizer typed, because the page numbers them', () => {
    expect(termsList('1. No refunds\n2) No re-entry\n- Masks optional\n• 16+ only')).toEqual([
      'No refunds',
      'No re-entry',
      'Masks optional',
      '16+ only',
    ]);
  });

  it('keeps a number that is part of the sentence', () => {
    // "18+ only" and "30 minutes" start with a number but are not a list marker.
    expect(termsList('18+ only\n30 minutes before the show')).toEqual([
      '18+ only',
      '30 minutes before the show',
    ]);
  });

  it('is empty when there are no terms', () => {
    expect(termsList(null)).toEqual([]);
    expect(termsList('   \n  ')).toEqual([]);
  });
});
