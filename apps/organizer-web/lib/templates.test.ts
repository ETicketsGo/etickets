import { describe, expect, it } from 'vitest';
import { categoryBody, categoryFieldFrom, OTHER_CATEGORY } from './templates';
import { validateBasics } from './event-wizard';

describe('Other event type', () => {
  it('saves Other as the category and the typed words as the event type', () => {
    expect(categoryBody('other', ' Poetry reading ')).toEqual({
      category: OTHER_CATEGORY,
      typeLabel: 'Poetry reading',
    });
    expect(categoryBody('list', 'Music')).toEqual({ category: 'Music', typeLabel: null });
  });

  it('fills the field from the event type, a listed category, or an older typed category', () => {
    expect(categoryFieldFrom({ category: 'Other', typeLabel: 'Book swap' })).toEqual({
      mode: 'other',
      text: 'Book swap',
    });
    expect(categoryFieldFrom({ category: 'Music', typeLabel: null })).toEqual({
      mode: 'list',
      text: 'Music',
    });
    // Saved before typeLabel existed: shown as typed, unchanged.
    expect(categoryFieldFrom({ category: 'Power BI training' })).toEqual({
      mode: 'other',
      text: 'Power BI training',
    });
  });

  it('refuses a typed event type that is too long or contains markup', () => {
    expect(validateBasics({ title: 'Night', category: 'x'.repeat(41) }).category).toMatch(/40/);
    expect(validateBasics({ title: 'Night', category: '<i>x</i>' }).category).toMatch(/< or >/);
    expect(validateBasics({ title: 'Night', category: 'Kids & Family' }).category).toBeUndefined();
  });
});
