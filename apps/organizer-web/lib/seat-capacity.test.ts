import { describe, expect, it } from 'vitest';
import { capacitySummary, nextGapSeats, type SectionDraft } from './seat-layout';

/*
  The founder's screenshot: a request for about 150 showed "153 seats to sell" in the planner
  and "162 bookable seats" under it. 162 is 9 rows x 18 - the aisle column counted as seats,
  because a re-plan never moved the aisle the first plan had written in.
*/
const section = (over: Partial<SectionDraft> = {}): SectionDraft => ({
  name: 'Stalls',
  categoryName: 'Standard',
  colorHex: '#1D4ED8',
  basePrice: '200',
  rowLabels: 'A-I',
  seatsPerRow: '18',
  wheelchairSeats: '',
  companionSeats: '',
  gapSeats: '9',
  ...over,
});

describe('nextGapSeats', () => {
  it('moves our own suggestion when the plan changes', () => {
    expect(nextGapSeats('7', '7', 9)).toBe('9');
  });
  it('fills an empty box', () => {
    expect(nextGapSeats('', '', 9)).toBe('9');
  });
  it('clears our suggestion when the new grid wants no aisle', () => {
    expect(nextGapSeats('9', '9', null)).toBe('');
  });
  it('never overwrites what the organizer typed', () => {
    expect(nextGapSeats('5, 14', '9', 7)).toBe('5, 14');
  });
});

describe('capacitySummary', () => {
  it('counts the aisle as a position, never as a bookable seat', () => {
    const s = capacitySummary([section()], [150]);
    expect(s).toMatchObject({ positions: 162, aisles: 9, bookable: 153, requested: 150 });
    expect(s.differsFromRequest).toBe(true);
  });

  it('agrees with itself when the room is exactly what was asked for', () => {
    const s = capacitySummary(
      [section({ rowLabels: 'A-J', seatsPerRow: '16', gapSeats: '8' })],
      [150],
    );
    expect(s.bookable).toBe(150);
    expect(s.differsFromRequest).toBe(false);
  });

  it('counts accessible places as bookable, and reports them', () => {
    const s = capacitySummary([section({ wheelchairSeats: '1', companionSeats: '2' })], [153]);
    expect(s.accessible).toBe(18);
    expect(s.bookable).toBe(153);
  });

  it('has no request to reconcile when nothing was planned', () => {
    const s = capacitySummary([section()], [null]);
    expect(s.requested).toBeNull();
    expect(s.differsFromRequest).toBe(false);
  });
});
