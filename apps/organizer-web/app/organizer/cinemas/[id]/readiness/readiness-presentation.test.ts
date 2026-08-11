import { describe, expect, it } from 'vitest';
import type { PilotReadinessReport, PilotReadinessLevel } from '@eticketsgo/web-kit';
import {
  aggregate,
  checkedAgo,
  headline,
  LEVEL_GLYPH,
  LEVEL_LABEL,
  LEVEL_TONE,
  onboardingSteps,
  outstanding,
  sectionLabel,
  sortSectionsByUrgency,
  STEP_STATE_LABEL,
  stepLevel,
  summarise,
} from './readiness-presentation';

/**
 * Presentation only.
 *
 * There are deliberately NO tests here asserting that a lone operator warns or that a missing
 * fee rule does not block — those are server rules, tested in `pilot-readiness.spec.ts`.
 * Asserting them again here would create the second source of truth this module exists to
 * avoid, and the two would drift the first time a policy changed.
 */

const check = (
  code: string,
  level: PilotReadinessLevel,
  section = 'CINEMA',
  fixPath: string | null = '/fix',
) => ({
  section,
  code,
  level,
  message: `${code} message that is long enough to be useful`,
  fixPath,
});

const report = (over: Partial<PilotReadinessReport> = {}): PilotReadinessReport => ({
  cinemaId: 'c1',
  cinemaName: 'Hyderabad Multiplex',
  timezone: 'Asia/Kolkata',
  overall: 'READY',
  blockers: 0,
  warnings: 0,
  sections: [{ section: 'CINEMA', level: 'READY', checks: [check('TIMEZONE_SET', 'READY')] }],
  evaluatedAt: new Date('2026-08-09T12:00:00Z').toISOString(),
  ...over,
});

describe('summarise', () => {
  it('counts each level across all sections', () => {
    const r = report({
      overall: 'BLOCKED',
      sections: [
        { section: 'CINEMA', level: 'READY', checks: [check('A', 'READY')] },
        {
          section: 'SCREENS',
          level: 'BLOCKED',
          checks: [check('B', 'BLOCKED', 'SCREENS'), check('C', 'WARNING', 'SCREENS')],
        },
      ],
    });
    expect(summarise(r)).toEqual({ ready: 1, warnings: 1, blockers: 1, overall: 'BLOCKED' });
  });

  it('uses the SERVER verdict, not a recomputed one', () => {
    /*
      The one number that decides whether a cinema may open must have a single source. If the
      server ever disagrees with a local aggregation, the server wins — otherwise the page can
      say READY over an API that refuses.
    */
    const r = report({
      overall: 'BLOCKED',
      sections: [{ section: 'CINEMA', level: 'READY', checks: [check('A', 'READY')] }],
    });
    expect(summarise(r).overall).toBe('BLOCKED');
  });

  it('falls back to aggregation only when the server sent no verdict', () => {
    const r = report({
      overall: undefined as never,
      sections: [{ section: 'FEES', level: 'WARNING', checks: [check('F', 'WARNING', 'FEES')] }],
    });
    expect(summarise(r).overall).toBe('WARNING');
  });
});

describe('aggregate', () => {
  it('lets a blocker outrank warnings', () => {
    expect(aggregate(['READY', 'WARNING', 'BLOCKED'])).toBe('BLOCKED');
  });
  it('warns when there is no blocker', () => {
    expect(aggregate(['READY', 'WARNING'])).toBe('WARNING');
  });
  it('is ready when everything is', () => {
    expect(aggregate(['READY', 'READY'])).toBe('READY');
    expect(aggregate([])).toBe('READY');
  });
});

describe('sortSectionsByUrgency', () => {
  it('puts blocking first and ready last', () => {
    // A checklist that lists twelve green sections above the one red one is a checklist
    // nobody reads to the bottom of.
    const sections = [
      { section: 'A', level: 'READY' as const, checks: [] },
      { section: 'B', level: 'WARNING' as const, checks: [] },
      { section: 'C', level: 'BLOCKED' as const, checks: [] },
    ];
    expect(sortSectionsByUrgency(sections).map((s) => s.section)).toEqual(['C', 'B', 'A']);
  });

  it('does not mutate the input', () => {
    const sections = [
      { section: 'A', level: 'READY' as const, checks: [] },
      { section: 'C', level: 'BLOCKED' as const, checks: [] },
    ];
    sortSectionsByUrgency(sections);
    expect(sections.map((s) => s.section)).toEqual(['A', 'C']);
  });
});

describe('outstanding', () => {
  it('returns only what is not ready', () => {
    const r = report({
      sections: [
        {
          section: 'CINEMA',
          level: 'BLOCKED',
          checks: [check('OK', 'READY'), check('BAD', 'BLOCKED'), check('MEH', 'WARNING')],
        },
      ],
    });
    expect(outstanding(r).map((c) => c.code)).toEqual(['BAD', 'MEH']);
  });
});

describe('headline', () => {
  it('says how many things must be fixed, not just the state', () => {
    // "3 things must be fixed" is actionable in a way "BLOCKED" is not.
    expect(headline({ ready: 5, warnings: 1, blockers: 3, overall: 'BLOCKED' })).toContain(
      '3 things must be fixed',
    );
  });
  it('gets the singular right', () => {
    const h = headline({ ready: 5, warnings: 0, blockers: 1, overall: 'BLOCKED' });
    expect(h).toContain('1 thing must be fixed');
    expect(h).not.toContain('1 things');
  });
  it('reassures when only warnings remain', () => {
    expect(headline({ ready: 9, warnings: 2, blockers: 0, overall: 'WARNING' })).toMatch(
      /Ready to open/,
    );
  });
  it('is unambiguous when everything passes', () => {
    expect(headline({ ready: 12, warnings: 0, blockers: 0, overall: 'READY' })).toMatch(
      /ready to open/i,
    );
  });
});

describe('level vocabulary', () => {
  it('every level has a label, a tone AND a glyph', () => {
    // Status must survive greyscale and colour-blindness, so it is never carried by tone
    // alone — a word and a shape as well.
    for (const level of ['READY', 'WARNING', 'BLOCKED'] as PilotReadinessLevel[]) {
      expect(LEVEL_LABEL[level]).toBeTruthy();
      expect(LEVEL_TONE[level]).toBeTruthy();
      expect(LEVEL_GLYPH[level]).toBeTruthy();
    }
  });

  it('distinguishes blocking from needing review in words', () => {
    expect(LEVEL_LABEL.BLOCKED).not.toBe(LEVEL_LABEL.WARNING);
    expect(LEVEL_GLYPH.BLOCKED).not.toBe(LEVEL_GLYPH.WARNING);
  });
});

describe('sectionLabel', () => {
  it('gives operator-facing names for known sections', () => {
    expect(sectionLabel('LAYOUTS')).toBe('Seat layouts');
    expect(sectionLabel('CUSTOMER')).toBe('Customer experience');
  });

  it('renders an unknown section as itself rather than blank', () => {
    // A newer API adding a section must not produce an unlabelled card.
    expect(sectionLabel('SETTLEMENT')).toBe('SETTLEMENT');
  });
});

describe('checkedAgo', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  it('reads naturally at each scale', () => {
    expect(checkedAgo('2026-08-09T11:59:55Z', now)).toBe('just now');
    expect(checkedAgo('2026-08-09T11:59:00Z', now)).toBe('60s ago');
    expect(checkedAgo('2026-08-09T11:50:00Z', now)).toBe('10 min ago');
  });
});

describe('onboardingSteps', () => {
  const steps = onboardingSteps('cin1');

  it('covers setup in the order an operator works', () => {
    expect(steps[0].label).toBe('Business');
    expect(steps[1].label).toBe('Cinema');
    expect(steps[steps.length - 1].label).toBe('Launch readiness');
  });

  it('links to the EXISTING screens rather than duplicating them', () => {
    // Rebuilding the seat-map designer or scheduling workspace inside a wizard would create a
    // second place to keep correct.
    expect(steps.find((s) => s.section === 'SHOWS')?.path).toBe('/organizer/cinemas/cin1/schedule');
    expect(steps.find((s) => s.section === 'OPERATIONS')?.path).toBe(
      '/organizer/cinemas/cin1/live',
    );
    expect(steps.find((s) => s.section === 'CINEMA')?.path).toBe('/organizer/cinemas/cin1');
  });

  it('states the gap where no self-service screen exists', () => {
    // Telling an operator to "configure fees" with no way to do it is worse than telling them
    // the screen does not exist and who owns it.
    for (const section of ['FEES', 'POLICIES', 'PAYMENTS']) {
      const step = steps.find((s) => s.section === section)!;
      expect(step.path).toBeNull();
      expect(step.gap, `${section} must explain itself`).toBeTruthy();
    }
  });

  it('never links somewhere without saying what it is for', () => {
    const bad = steps.filter((s) => s.path === null && !s.gap).map((s) => s.label);
    expect(bad).toEqual([]);
  });
});

describe('stepLevel', () => {
  const steps = onboardingSteps('cin1');
  const cinemaStep = steps.find((s) => s.section === 'CINEMA')!;
  const reviewStep = steps.find((s) => s.section === null)!;

  it('reflects the live readiness verdict, not a stored flag', () => {
    /*
      Progress is derived every time precisely so it cannot go stale. A wizard reporting
      "complete" over a cinema that can no longer sell a ticket is worse than no wizard.
    */
    const r = report({
      sections: [{ section: 'CINEMA', level: 'BLOCKED', checks: [check('X', 'BLOCKED')] }],
    });
    expect(stepLevel(cinemaStep, r)).toBe('BLOCKED');
  });

  it('can regress when configuration changes', () => {
    const before = report({
      sections: [{ section: 'CINEMA', level: 'READY', checks: [check('X', 'READY')] }],
    });
    const after = report({
      sections: [{ section: 'CINEMA', level: 'BLOCKED', checks: [check('X', 'BLOCKED')] }],
    });
    expect(stepLevel(cinemaStep, before)).toBe('READY');
    expect(stepLevel(cinemaStep, after)).toBe('BLOCKED');
  });

  it('uses the overall verdict for the final review step', () => {
    expect(stepLevel(reviewStep, report({ overall: 'WARNING' }))).toBe('WARNING');
  });

  it('is UNKNOWN before readiness has loaded, rather than falsely complete', () => {
    expect(stepLevel(cinemaStep, undefined)).toBe('UNKNOWN');
    expect(STEP_STATE_LABEL.UNKNOWN).toBe('Not checked');
  });

  it('is UNKNOWN for a section the server did not report', () => {
    expect(stepLevel(cinemaStep, report({ sections: [] }))).toBe('UNKNOWN');
  });
});
