import { countsTowardsCap, overCapBy, standingCapProblem } from './standing-capacity';

/**
 * A standing space's capacity caps what one session puts on sale.
 *
 * Found walking QA: a space "Walk L2 Lawn - holds 100" and a general-admission event there with
 * 500 tickets on sale, accepted without a word. The rule is the sum of the session's ACTIVE
 * quantities; existing over-cap data may only come down.
 */
describe('standingCapProblem', () => {
  const lawn = { spaceName: 'Main Lawn', capacity: 100 };

  it('allows an offer that fits', () => {
    expect(standingCapProblem({ ...lawn, others: 60, next: 40, previous: 0 })).toBeNull();
  });

  it('refuses a first ticket type bigger than the space, saying what it holds', () => {
    expect(standingCapProblem({ ...lawn, others: 0, next: 500, previous: 0 })).toBe(
      "Main Lawn holds 100 people. You cannot put 500 tickets on sale for one session there. Lower the quantity, or raise the space's capacity under Venues & seating.",
    );
  });

  it('says how many more fit when other ticket types already use some of it', () => {
    expect(standingCapProblem({ ...lawn, others: 80, next: 30, previous: 0 })).toBe(
      "Main Lawn holds 100 people. This session already has 80 tickets on sale, so you can add at most 20 more. Lower the quantity, or raise the space's capacity under Venues & seating.",
    );
  });

  it('says none fit when the space is already full', () => {
    expect(standingCapProblem({ ...lawn, others: 100, next: 1, previous: 0 })).toContain(
      'so you can add no more',
    );
  });

  it('lets a session already over the cap come down', () => {
    // 500 on sale before the rule existed: lowering to 300 is still over, and allowed.
    expect(standingCapProblem({ ...lawn, others: 0, next: 300, previous: 500 })).toBeNull();
  });

  it('refuses raising a session that is already over the cap', () => {
    expect(standingCapProblem({ ...lawn, others: 0, next: 501, previous: 500 })).not.toBeNull();
  });

  it('allows exactly the capacity', () => {
    expect(standingCapProblem({ ...lawn, others: 50, next: 50, previous: 0 })).toBeNull();
  });
});

describe('countsTowardsCap / overCapBy', () => {
  it('counts only ticket types on sale', () => {
    expect(countsTowardsCap('ACTIVE')).toBe(true);
    expect(countsTowardsCap(undefined)).toBe(true);
    expect(countsTowardsCap('INACTIVE')).toBe(false);
  });

  it('flags by how much a session is over, never negative', () => {
    expect(overCapBy(100, 500)).toBe(400);
    expect(overCapBy(100, 80)).toBe(0);
  });
});
