import type {
  PilotReadinessReport,
  PilotReadinessCheck,
  PilotReadinessLevel,
} from '@eticketsgo/web-kit';

/**
 * Presentation for launch readiness.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────────────
 * It contains NO rules. Whether a lone operator is a warning, whether a missing fee rule
 * blocks, what counts as discoverable — all of that is decided by the server and arrives in
 * the response. A second implementation here is exactly how a page ends up reporting READY
 * while the API refuses to activate.
 *
 * What lives here is only how to SAY it: labels, ordering, icons, counts.
 */

/** Mirrors web-kit's BadgeTone. There is no 'danger'; the error tone is called 'error'. */
export type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

export const LEVEL_LABEL: Record<PilotReadinessLevel, string> = {
  READY: 'Ready',
  WARNING: 'Needs review',
  BLOCKED: 'Blocking',
};

export const LEVEL_TONE: Record<PilotReadinessLevel, Tone> = {
  READY: 'success',
  WARNING: 'warning',
  BLOCKED: 'error',
};

/**
 * A text glyph per level.
 *
 * Status must survive greyscale, colour-blindness and a screen reader, so every badge carries
 * a word AND a shape. Colour alone has already been fixed once on this product.
 */
export const LEVEL_GLYPH: Record<PilotReadinessLevel, string> = {
  READY: '✓',
  WARNING: '!',
  BLOCKED: '×',
};

/** Operator-facing section names. The server sends stable keys; these are the words. */
export const SECTION_LABEL: Record<string, string> = {
  BUSINESS: 'Business',
  CINEMA: 'Cinema',
  SCREENS: 'Screens',
  LAYOUTS: 'Seat layouts',
  STAFF: 'Staff',
  PRICING: 'Pricing',
  FEES: 'Fees',
  POLICIES: 'Policies',
  PAYMENTS: 'Payments',
  SHOWS: 'Shows',
  CUSTOMER: 'Customer experience',
  OPERATIONS: 'Operations',
};

/** A section name the client does not know renders as itself rather than vanishing. */
export function sectionLabel(section: string): string {
  return SECTION_LABEL[section] ?? section;
}

export interface ReadinessSummary {
  ready: number;
  warnings: number;
  blockers: number;
  overall: PilotReadinessLevel;
}

/**
 * Counts for the scorecard.
 *
 * `overall` is taken from the SERVER's verdict, not recomputed. The aggregation rule below is
 * only a fallback for a response that predates the field — recomputing it by default would be
 * a second source of truth for the one number that decides whether a cinema may open.
 */
export function summarise(report: PilotReadinessReport): ReadinessSummary {
  const checks = report.sections.flatMap((s) => s.checks);
  return {
    ready: checks.filter((c) => c.level === 'READY').length,
    warnings: checks.filter((c) => c.level === 'WARNING').length,
    blockers: checks.filter((c) => c.level === 'BLOCKED').length,
    overall: report.overall ?? aggregate(checks.map((c) => c.level)),
  };
}

/** Presentation-only fallback: any blocker blocks, otherwise any warning warns. */
export function aggregate(levels: PilotReadinessLevel[]): PilotReadinessLevel {
  if (levels.includes('BLOCKED')) return 'BLOCKED';
  if (levels.includes('WARNING')) return 'WARNING';
  return 'READY';
}

/**
 * Sections worth an operator's attention first.
 *
 * Blocking before warning before ready. A launch checklist that lists twelve green sections
 * above the one red one is a checklist nobody reads to the bottom of.
 */
export function sortSectionsByUrgency(
  sections: PilotReadinessReport['sections'],
): PilotReadinessReport['sections'] {
  const rank: Record<PilotReadinessLevel, number> = { BLOCKED: 0, WARNING: 1, READY: 2 };
  return [...sections].sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Only the things standing in the way, for the summary line. */
export function outstanding(report: PilotReadinessReport): PilotReadinessCheck[] {
  return report.sections
    .flatMap((s) => s.checks)
    .filter((c) => c.level !== 'READY')
    .sort((a, b) => (a.level === 'BLOCKED' ? -1 : 1) - (b.level === 'BLOCKED' ? -1 : 1));
}

/**
 * One sentence for the top of the page.
 *
 * Says what to do, not merely what state things are in — "3 things must be fixed" is
 * actionable in a way that "BLOCKED" is not.
 */
export function headline(summary: ReadinessSummary): string {
  if (summary.overall === 'BLOCKED') {
    return `${summary.blockers} thing${summary.blockers === 1 ? '' : 's'} must be fixed before this cinema can open.`;
  }
  if (summary.overall === 'WARNING') {
    return `Ready to open, with ${summary.warnings} thing${
      summary.warnings === 1 ? '' : 's'
    } worth reviewing first.`;
  }
  return 'Everything checks out. This cinema is ready to open.';
}

/** How stale the verdict is. A readiness page that cannot say this invites blind trust. */
export function checkedAgo(evaluatedAt: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(evaluatedAt).getTime()) / 1000));
  if (seconds < 15) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

// ── Onboarding shell ──────────────────────────────────────────────────────────────

export interface OnboardingStep {
  /** Readiness section this step reflects, or null for the final review step. */
  section: string | null;
  label: string;
  /** Where the operator actually does the work. Null when no UI exists yet. */
  path: string | null;
  /** Stated plainly when the configuration surface does not exist. */
  gap?: string;
}

/**
 * The setup order, and where each step's work is actually done.
 *
 * This shell is ORCHESTRATION, not a second product surface. Every step that has an existing
 * screen links to it; duplicating the seat-map designer or the scheduling workspace inside a
 * wizard would create a second place to keep correct.
 *
 * Steps with no destination say so rather than linking nowhere — an operator told "configure
 * pricing" with no way to do it is worse off than one told the screen does not exist yet.
 */
export function onboardingSteps(cinemaId: string): OnboardingStep[] {
  const cinema = `/organizer/cinemas/${cinemaId}`;
  return [
    { section: 'BUSINESS', label: 'Business', path: '/organizer/settings' },
    { section: 'CINEMA', label: 'Cinema', path: cinema },
    { section: 'SCREENS', label: 'Screens', path: cinema },
    { section: 'LAYOUTS', label: 'Seat layouts', path: cinema },
    { section: 'STAFF', label: 'Staff', path: '/organizer/team' },
    {
      section: 'PRICING',
      label: 'Pricing',
      // Prices are set per seat category when a layout is generated; there is no dedicated
      // editor yet. Sending the operator to the screen is the closest honest destination.
      path: cinema,
    },
    {
      section: 'FEES',
      label: 'Fees',
      path: null,
      gap: 'Convenience fee rules are configured by ETicketsGo, not by the theater. No organizer screen exists yet.',
    },
    {
      section: 'POLICIES',
      label: 'Policies',
      path: null,
      gap: 'Cancellation policy is stored per event and has no dedicated configuration screen yet.',
    },
    {
      section: 'PAYMENTS',
      label: 'Payments',
      path: null,
      gap: 'Payment routing is platform configuration. Contact ETicketsGo support to enable INR settlement.',
    },
    { section: 'SHOWS', label: 'Shows', path: `${cinema}/schedule` },
    { section: 'OPERATIONS', label: 'Live operations', path: `${cinema}/live` },
    { section: null, label: 'Launch readiness', path: `${cinema}/readiness` },
  ];
}

/**
 * A step's state, derived from readiness rather than a stored wizard flag.
 *
 * Deliberately NOT persisted. A checkbox someone ticked last week can disagree with reality —
 * a screen taken out of service, a layout archived — and a wizard that says "complete" over a
 * cinema that cannot sell a ticket is worse than no wizard. Progress is recomputed from the
 * live configuration every time, so leaving and returning always shows the truth.
 */
export function stepLevel(
  step: OnboardingStep,
  report: PilotReadinessReport | undefined,
): PilotReadinessLevel | 'UNKNOWN' {
  if (!report) return 'UNKNOWN';
  if (step.section === null) return report.overall;
  const section = report.sections.find((s) => s.section === step.section);
  return section?.level ?? 'UNKNOWN';
}

export const STEP_STATE_LABEL: Record<PilotReadinessLevel | 'UNKNOWN', string> = {
  READY: 'Complete',
  WARNING: 'Needs review',
  BLOCKED: 'Blocked',
  UNKNOWN: 'Not checked',
};
