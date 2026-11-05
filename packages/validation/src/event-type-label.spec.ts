import { describe, expect, it } from 'vitest';
import { createEventSchema } from './event';

/*
  "Other event type": the organizer's own words are printed on cards, the event page and emails,
  so they are short plain text. Empty clears the field instead of storing "".
*/
describe('createEventSchema typeLabel', () => {
  const base = {
    title: 'Poetry night',
    category: 'Other',
    venueId: 'ckvenue0000000000000000000',
  };
  const parse = (typeLabel: unknown) =>
    createEventSchema.partial().safeParse({ ...base, typeLabel });

  it('keeps a short label, trimmed and without control characters', () => {
    const r = parse('  Poetry\u0007 reading ');
    expect(r.success && r.data.typeLabel).toBe('Poetry reading');
  });

  it('turns an empty label into null', () => {
    const r = parse('   ');
    expect(r.success && r.data.typeLabel).toBeNull();
  });

  it('refuses markup and anything over 40 characters', () => {
    expect(parse('<b>Gig</b>').success).toBe(false);
    expect(parse('x'.repeat(41)).success).toBe(false);
    expect(parse('x'.repeat(40)).success).toBe(true);
  });

  it('is optional, so older clients still validate', () => {
    expect(createEventSchema.partial().safeParse(base).success).toBe(true);
  });
});
