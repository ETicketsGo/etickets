import { describe, expect, it } from 'vitest';
import {
  MAX_ROWS,
  MAX_SEATS_PER_ROW,
  MAX_SECTION_SEATS,
  ROOM_SHAPES,
  planRoom,
  rowLabel,
  suggestedAisle,
} from './room-plan';

/**
 * Turning a capacity into a room.
 *
 * The organizer types "about 100 seats" and gets rows and columns back. What matters is not
 * that the arithmetic runs, but that the answers are ones a person would recognise as their
 * own cinema — so these tests assert the SHAPE of the result, not just its size.
 */

const shape = (key: string) => ROOM_SHAPES.find((s) => s.key === key)!;

describe('planRoom', () => {
  it('never seats fewer people than were asked for', () => {
    /*
      The rule that must not bend.

      Rounding down quietly sells a smaller room than the organizer described, and the
      discrepancy surfaces as a sold-out show with empty chairs in it. Rounding up at worst
      adds a short final row, which is what a real room does anyway.
    */
    const short: string[] = [];
    for (const s of ROOM_SHAPES) {
      for (const capacity of [1, 7, 33, 50, 99, 100, 137, 250, 501, 1000]) {
        const plan = planRoom(capacity, s);
        // SELLABLE, not total: the aisle column is part of the grid and not part of the house.
        if (plan.sellable < capacity) short.push(`${s.key}@${capacity} → ${plan.sellable}`);
        if (plan.rows * plan.seatsPerRow !== plan.total) short.push(`${s.key}@${capacity} maths`);
      }
    }
    expect(short).toEqual([]);
  });

  it('does not waste much doing it', () => {
    // A plan that seats everybody by adding forty empty chairs is arithmetically correct and
    // useless. Nothing here should overshoot by more than a row's worth.
    const wasteful: string[] = [];
    for (const s of ROOM_SHAPES) {
      for (const capacity of [40, 100, 150, 320, 500]) {
        const plan = planRoom(capacity, s);
        if (plan.sellable - capacity >= plan.seatsPerRow) {
          wasteful.push(`${s.key}@${capacity} → ${plan.sellable} (+${plan.sellable - capacity})`);
        }
      }
    }
    expect(wasteful).toEqual([]);
  });

  it('makes a cinema wider than it is deep', () => {
    // A hundred seats as 4 rows of 25 seats everybody and looks nothing like a screen.
    const plan = planRoom(100, shape('STANDARD_SCREEN'));
    expect(plan.seatsPerRow).toBeGreaterThan(plan.rows);
    expect(plan.sellable).toBeGreaterThanOrEqual(100);
  });

  it('plans around the aisle it is going to suggest', () => {
    /*
      The headline number and the preview must agree.

      Planning on the grid meant "100 seats" produced 10×10 with an aisle down the middle and
      NINETY bookable — the summary and the seat preview disagreeing by a tenth of the room.
    */
    const plan = planRoom(100, shape('STANDARD_SCREEN'));
    if (plan.aisle !== null) {
      expect(plan.rows * (plan.seatsPerRow - 1)).toBe(plan.sellable);
    } else {
      expect(plan.total).toBe(plan.sellable);
    }
    expect(plan.sellable).toBeGreaterThanOrEqual(100);
  });

  it('makes a flat hall squarer than a cinema, for the same capacity', () => {
    /*
      The reason shape is asked for at all.

      A hundred seats is not one layout: in a hall it is nearly square, on a screen it is
      long rows. If both produced the same grid the question would be pointless.
    */
    const hall = planRoom(100, shape('FLAT_HALL'));
    const screen = planRoom(100, shape('STANDARD_SCREEN'));
    expect(hall.seatsPerRow / hall.rows).toBeLessThan(screen.seatsPerRow / screen.rows);
  });

  it('makes a large screen wider still', () => {
    const large = planRoom(320, shape('LARGE_SCREEN'));
    const standard = planRoom(320, shape('STANDARD_SCREEN'));
    expect(large.seatsPerRow / large.rows).toBeGreaterThan(standard.seatsPerRow / standard.rows);
  });

  it('keeps rows to a length a real room has', () => {
    // The API caps a section at 40 rows of 60. A big capacity must grow by adding rows, not
    // by making one enormous one — and must never exceed what the API will accept.
    const plan = planRoom(1000, shape('AUDITORIUM'));
    expect(plan.seatsPerRow).toBeLessThanOrEqual(60);
    expect(plan.rows).toBeLessThanOrEqual(40);
    expect(plan.rows).toBeGreaterThan(10);
    expect(plan.exceedsSection).toBe(false);
  });

  it('labels every row, and hands back as many labels as rows', () => {
    for (const s of ROOM_SHAPES) {
      const plan = planRoom(400, s);
      expect(plan.rowLabels).toHaveLength(plan.rows);
      expect(new Set(plan.rowLabels).size).toBe(plan.rows);
    }
  });

  it('copes with one seat', () => {
    const plan = planRoom(1, shape('SCREENING_ROOM'));
    expect(plan.total).toBe(1);
    expect(plan.rowLabels).toEqual(['A']);
  });

  it('says so when a room is too big for one section, instead of shrinking it silently', () => {
    /*
      Above 2,400 there is no legal answer: every row count leaves more than sixty seats in a
      row. Returning the biggest legal room WITHOUT saying so would seat a third of a stadium
      and look like it worked.
    */
    const plan = planRoom(5000, shape('AUDITORIUM'));
    expect(plan.exceedsSection).toBe(true);
    expect(plan.sellable).toBe(MAX_SECTION_SEATS);
    expect(plan.rows).toBe(MAX_ROWS);
    expect(plan.seatsPerRow).toBe(MAX_SEATS_PER_ROW);
    // …and it is still a legal room, so the form can submit what it shows.
    expect(plan.rowLabels).toHaveLength(MAX_ROWS);
  });

  it('does not raise the flag for a room that does fit', () => {
    expect(planRoom(MAX_SECTION_SEATS, shape('AUDITORIUM')).exceedsSection).toBe(false);
  });

  it('is deterministic', () => {
    // An organizer who types 100, changes their mind, and types 100 again must get the same
    // room back — otherwise the preview looks unstable and nothing feels trustworthy.
    expect(planRoom(137, shape('STANDARD_SCREEN'))).toEqual(
      planRoom(137, shape('STANDARD_SCREEN')),
    );
  });
});

describe('rowLabel', () => {
  it('keeps counting past Z, which a big auditorium needs', () => {
    /*
      The old expansion understood single letters only, so a room deeper than twenty-six rows
      could not be described at all — and an auditorium reaches that easily.
    */
    expect(rowLabel(0)).toBe('A');
    expect(rowLabel(25)).toBe('Z');
    // Not "[", which is what String.fromCharCode(65 + 26) gives.
    expect(rowLabel(26)).toBe('AA');
    expect(rowLabel(27)).toBe('AB');
    expect(rowLabel(51)).toBe('AZ');
    expect(rowLabel(52)).toBe('BA');
  });

  it('never repeats a label within a plausible room', () => {
    // Two rows sharing a label collide on the (row, label) unique index and fail the whole
    // generation with a database error rather than a readable one.
    const labels = Array.from({ length: 200 }, (_unused, i) => rowLabel(i));
    expect(new Set(labels).size).toBe(200);
  });
});

describe('suggestedAisle', () => {
  it('puts one down the middle of a wide row', () => {
    expect(suggestedAisle(15)).toBe(8);
    expect(suggestedAisle(20)).toBe(10);
  });

  it('suggests none in a narrow row', () => {
    // A gap in an eight-seat row costs a seat and saves nobody a walk.
    expect(suggestedAisle(8)).toBeNull();
    expect(suggestedAisle(6)).toBeNull();
  });
});
