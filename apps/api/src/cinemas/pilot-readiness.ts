/**
 * Pilot readiness rules.
 *
 * Pure functions on plain facts — no Prisma, no Nest — so every rule is exhaustively
 * testable and there is exactly ONE place that decides whether a cinema can open. The
 * organizer page renders this; it never re-derives it. A second implementation in the client
 * is how a screen ends up saying READY while the API refuses to activate.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────────────
 * A theater manager must be able to answer "what is stopping this cinema going live?"
 * without asking engineering. So every check names the thing that is wrong, and carries a
 * stable code the UI turns into a link to the page that fixes it.
 */

export type ReadinessLevel = 'READY' | 'WARNING' | 'BLOCKED';

export type ReadinessSection =
  | 'BUSINESS'
  | 'CINEMA'
  | 'SCREENS'
  | 'LAYOUTS'
  | 'STAFF'
  | 'PRICING'
  | 'FEES'
  | 'POLICIES'
  | 'PAYMENTS'
  | 'SHOWS'
  | 'CUSTOMER'
  | 'OPERATIONS';

export interface ReadinessCheck {
  section: ReadinessSection;
  /** Stable identifier. The UI maps this to a fix link; never match on the message. */
  code: string;
  level: ReadinessLevel;
  /** One sentence an operator can act on, naming what is actually missing. */
  message: string;
  /** Where to go to fix it, relative to the organizer app. Null when there is nowhere useful. */
  fixPath: string | null;
}

/** Everything the rules need, gathered by the service in one pass. */
export interface ReadinessFacts {
  cinemaId: string;
  organization: {
    status: string;
    contactEmail: string | null;
    contactPhone: string | null;
  };
  cinema: {
    timezone: string;
    status: string;
    address: string | null;
    city: string;
  };
  /** Screens the cinema can actually run tonight. */
  activeScreens: number;
  totalScreens: number;
  /** Active screens that have no published layout — each one is unusable. */
  activeScreensWithoutPublishedLayout: string[];
  /** Members of the owning organization who could operate this cinema. */
  operatorCount: number;
  /** Seat categories across published layouts that carry a price. */
  pricedCategories: number;
  unpricedCategories: number;
  /** Active fee rules that could apply to an INR ticket. */
  activeFeeRules: number;
  /** Whether any cancellation/refund policy text is configured for this cinema's events. */
  hasCancellationPolicy: boolean;
  /** An INR payment route the booking engine can actually select. */
  hasInrPaymentRoute: boolean;
  /** Provider credentials resolvable in this environment (never the values themselves). */
  paymentProviderConfigured: boolean;
  /** Future shows already on sale. */
  futurePublishedShows: number;
  /** Whether the public catalogue can serve this cinema's films. */
  publicCatalogueReachable: boolean;
}

const ok = (section: ReadinessSection, code: string, message: string): ReadinessCheck => ({
  section,
  code,
  level: 'READY',
  message,
  fixPath: null,
});

/**
 * Evaluate every rule.
 *
 * Order is the order an operator works in, not alphabetical: business, then the room, then
 * what it sells, then whether anyone can buy. Reading the list top to bottom should feel like
 * the setup itself.
 */
export function evaluatePilotReadiness(f: ReadinessFacts): ReadinessCheck[] {
  const c: ReadinessCheck[] = [];
  const cinemaPath = `/organizer/cinemas/${f.cinemaId}`;

  // ── Business ──────────────────────────────────────────────────────────────────
  if (f.organization.status !== 'ACTIVE') {
    c.push({
      section: 'BUSINESS',
      code: 'ORG_NOT_ACTIVE',
      level: 'BLOCKED',
      message: `The organization is ${f.organization.status.toLowerCase()}, so nothing it owns can sell tickets.`,
      fixPath: '/organizer/settings',
    });
  } else {
    c.push(ok('BUSINESS', 'ORG_ACTIVE', 'Organization is active.'));
  }

  if (!f.organization.contactEmail) {
    // A warning, not a blocker: tickets can sell without it, but nobody can be reached when
    // something goes wrong on the night — which is precisely when it is needed.
    c.push({
      section: 'BUSINESS',
      code: 'NO_SUPPORT_EMAIL',
      level: 'WARNING',
      message: 'No support email is set, so customers have no way to reach the theater.',
      fixPath: '/organizer/settings',
    });
  } else {
    c.push(ok('BUSINESS', 'SUPPORT_EMAIL_SET', 'Support email is set.'));
  }

  // ── Cinema ────────────────────────────────────────────────────────────────────
  // The zone is NOT NULL in the schema, so this can only fail if something wrote around the
  // API. Checked anyway, because an unresolvable zone breaks every date the venue renders.
  if (!f.cinema.timezone) {
    c.push({
      section: 'CINEMA',
      code: 'NO_TIMEZONE',
      level: 'BLOCKED',
      message: 'The cinema has no timezone, so its local showtimes cannot be computed.',
      fixPath: cinemaPath,
    });
  } else {
    c.push(ok('CINEMA', 'TIMEZONE_SET', `Local times are reckoned in ${f.cinema.timezone}.`));
  }

  if (!f.cinema.address) {
    c.push({
      section: 'CINEMA',
      code: 'NO_ADDRESS',
      level: 'WARNING',
      message: 'No street address, so customers cannot find the venue from the listing.',
      fixPath: cinemaPath,
    });
  }

  if (f.cinema.status !== 'ACTIVE') {
    c.push({
      section: 'CINEMA',
      code: 'CINEMA_NOT_ACTIVE',
      level: 'BLOCKED',
      message: `The cinema is ${f.cinema.status.toLowerCase()}. Activate it once the checks below pass.`,
      fixPath: cinemaPath,
    });
  }

  // ── Screens and layouts ───────────────────────────────────────────────────────
  if (f.activeScreens === 0) {
    c.push({
      section: 'SCREENS',
      code: 'NO_ACTIVE_SCREEN',
      level: 'BLOCKED',
      message:
        f.totalScreens === 0
          ? 'No screens have been created yet.'
          : `All ${f.totalScreens} screens are out of service.`,
      fixPath: cinemaPath,
    });
  } else {
    c.push(ok('SCREENS', 'ACTIVE_SCREEN', `${f.activeScreens} screen(s) in service.`));
  }

  if (f.activeScreensWithoutPublishedLayout.length > 0) {
    // An in-service screen with no published layout cannot sell a single seat, and the
    // failure only shows up when somebody tries to schedule on it.
    c.push({
      section: 'LAYOUTS',
      code: 'SCREEN_WITHOUT_PUBLISHED_LAYOUT',
      level: 'BLOCKED',
      message: `${f.activeScreensWithoutPublishedLayout.join(
        ', ',
      )} ${f.activeScreensWithoutPublishedLayout.length === 1 ? 'is' : 'are'} in service with no published seat layout, so no seats can be sold there.`,
      fixPath: cinemaPath,
    });
  } else if (f.activeScreens > 0) {
    c.push(ok('LAYOUTS', 'LAYOUTS_PUBLISHED', 'Every in-service screen has a published layout.'));
  }

  // ── Staff ─────────────────────────────────────────────────────────────────────
  if (f.operatorCount === 0) {
    c.push({
      section: 'STAFF',
      code: 'NO_OPERATOR',
      level: 'BLOCKED',
      message: 'Nobody can operate this cinema — add at least one manager or admin.',
      fixPath: '/organizer/team',
    });
  } else if (f.operatorCount === 1) {
    // Not a blocker, but one person is a single point of failure on a pilot night.
    c.push({
      section: 'STAFF',
      code: 'SINGLE_OPERATOR',
      level: 'WARNING',
      message:
        'Only one person can operate this cinema. If they are unavailable on the night, nobody can pause sales or release a seat.',
      fixPath: '/organizer/team',
    });
  } else {
    c.push(ok('STAFF', 'OPERATORS_PRESENT', `${f.operatorCount} people can operate this cinema.`));
  }

  // ── Pricing ───────────────────────────────────────────────────────────────────
  if (f.pricedCategories === 0) {
    c.push({
      section: 'PRICING',
      code: 'NO_PRICING',
      level: 'BLOCKED',
      message: 'No seat category has a price, so no ticket can be sold.',
      fixPath: cinemaPath,
    });
  } else if (f.unpricedCategories > 0) {
    c.push({
      section: 'PRICING',
      code: 'UNPRICED_CATEGORIES',
      level: 'WARNING',
      message: `${f.unpricedCategories} seat categor${
        f.unpricedCategories === 1 ? 'y has' : 'ies have'
      } no price and will sell at zero.`,
      fixPath: cinemaPath,
    });
  } else {
    c.push(ok('PRICING', 'PRICING_SET', 'Every seat category is priced.'));
  }

  // ── Fees ──────────────────────────────────────────────────────────────────────
  if (f.activeFeeRules === 0) {
    // Deliberately a warning: selling with no convenience fee is a valid commercial choice,
    // it is just far more often an oversight.
    c.push({
      section: 'FEES',
      code: 'NO_FEE_RULE',
      level: 'WARNING',
      message:
        'No active convenience fee rule. Tickets will sell with no booking fee — intended for a pilot, but confirm it.',
      fixPath: '/admin/fees',
    });
  } else {
    c.push(ok('FEES', 'FEE_RULES_ACTIVE', `${f.activeFeeRules} fee rule(s) active.`));
  }

  // ── Policies ──────────────────────────────────────────────────────────────────
  if (!f.hasCancellationPolicy) {
    c.push({
      section: 'POLICIES',
      code: 'NO_CANCELLATION_POLICY',
      level: 'WARNING',
      message:
        'No cancellation policy is published, so customers are not told what happens if they cannot attend.',
      fixPath: cinemaPath,
    });
  } else {
    c.push(ok('POLICIES', 'POLICY_SET', 'A cancellation policy is published.'));
  }

  // ── Payments ──────────────────────────────────────────────────────────────────
  if (!f.hasInrPaymentRoute) {
    c.push({
      section: 'PAYMENTS',
      code: 'NO_INR_ROUTE',
      level: 'BLOCKED',
      message: 'No INR payment route is configured, so checkout cannot complete.',
      fixPath: '/admin/payments',
    });
  } else {
    c.push(ok('PAYMENTS', 'INR_ROUTE', 'An INR payment route is available.'));
  }

  if (!f.paymentProviderConfigured) {
    c.push({
      section: 'PAYMENTS',
      code: 'PROVIDER_NOT_CONFIGURED',
      level: 'BLOCKED',
      message:
        'The payment provider has no usable credentials in this environment, so no payment can be taken.',
      fixPath: '/admin/payments',
    });
  }

  // ── Shows ─────────────────────────────────────────────────────────────────────
  if (f.futurePublishedShows === 0) {
    c.push({
      section: 'SHOWS',
      code: 'NO_FUTURE_SHOWS',
      level: 'BLOCKED',
      message: 'No future shows are scheduled, so there is nothing for a customer to buy.',
      fixPath: `${cinemaPath}/schedule`,
    });
  } else {
    c.push(ok('SHOWS', 'FUTURE_SHOWS', `${f.futurePublishedShows} future show(s) scheduled.`));
  }

  // ── Customer experience ───────────────────────────────────────────────────────
  if (!f.publicCatalogueReachable) {
    c.push({
      section: 'CUSTOMER',
      code: 'CATALOGUE_UNREACHABLE',
      level: 'BLOCKED',
      message:
        'No published film is bookable at this cinema, so customers cannot discover it even though shows exist.',
      fixPath: '/organizer/movies',
    });
  } else {
    c.push(ok('CUSTOMER', 'CATALOGUE_REACHABLE', 'Customers can discover and open this cinema.'));
  }

  // ── Operations ────────────────────────────────────────────────────────────────
  // Live operations needs a screen in service and something to operate. It has no config of
  // its own, so it is READY exactly when those hold.
  const opsReady = f.activeScreens > 0 && f.futurePublishedShows > 0;
  c.push(
    opsReady
      ? ok('OPERATIONS', 'OPS_AVAILABLE', 'Live operations is available for tonight.')
      : {
          section: 'OPERATIONS',
          code: 'OPS_UNAVAILABLE',
          level: 'WARNING',
          message: 'Live operations has nothing to show until a screen is in service with shows.',
          fixPath: `${cinemaPath}/live`,
        },
  );

  return c;
}

/**
 * The single verdict.
 *
 * Any BLOCKED blocks. Warnings never block — they exist so an operator can make an informed
 * choice, and a checklist that refuses to let anyone proceed over an optional field is one
 * people learn to route around.
 */
export function overallReadiness(checks: ReadinessCheck[]): ReadinessLevel {
  if (checks.some((x) => x.level === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((x) => x.level === 'WARNING')) return 'WARNING';
  return 'READY';
}

/** Group for display, preserving the operator-facing order above. */
export const READINESS_SECTIONS: ReadinessSection[] = [
  'BUSINESS',
  'CINEMA',
  'SCREENS',
  'LAYOUTS',
  'STAFF',
  'PRICING',
  'FEES',
  'POLICIES',
  'PAYMENTS',
  'SHOWS',
  'CUSTOMER',
  'OPERATIONS',
];
