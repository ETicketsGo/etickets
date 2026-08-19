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

import { evaluatePaymentProvider, type PaymentReadinessFacts } from './payment-readiness';

export type { ReadinessCheck, ReadinessLevel, ReadinessSection } from './readiness-types';
import type { ReadinessCheck, ReadinessLevel, ReadinessSection } from './readiness-types';

/** Everything the rules need, gathered by the service in one pass. */
export interface ReadinessFacts {
  cinemaId: string;
  organization: {
    /**
     * The real enum, not `string`.
     *
     * `string` is how this rule came to compare against 'ACTIVE' — a value the column has
     * never been able to hold — and block every organization on the platform for months.
     * Naming the four states makes that particular mistake a compile error.
     */
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
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
  /**
   * Seat categories across published layouts that carry a price.
   *
   * This is the TEMPLATE a newly scheduled show is created from, not what anything sells
   * for. See `futureShowsWithZeroPrice` for the question that actually blocks.
   */
  pricedCategories: number;
  unpricedCategories: number;
  /** Upcoming shows with at least one on-sale ticket type priced at or below zero. */
  futureShowsWithZeroPrice: number;
  /** Upcoming shows whose on-sale ticket types all carry a real price. */
  futureShowsPriced: number;
  /** Active fee rules that could apply to an INR ticket. */
  activeFeeRules: number;
  /** Whether any cancellation/refund policy text is configured for this cinema's events. */
  hasCancellationPolicy: boolean;
  /** An INR payment route the booking engine can actually select. */
  hasInrPaymentRoute: boolean;
  /**
   * What this environment can actually charge with.
   *
   * Deliberately a structure, not a boolean. The old `paymentProviderConfigured: boolean`
   * flattened "which gateway", "which environment" and "test or live" into one bit, and the
   * bit was computed from a variable that does not exist. See `payment-readiness.ts`.
   */
  payments: PaymentReadinessFacts;
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
  const schedulePath = `${cinemaPath}/schedule`;

  /*
    ── Business ──────────────────────────────────────────────────────────────────

    APPROVED, not ACTIVE. `OrganizationStatus` is PENDING | APPROVED | REJECTED | SUSPENDED
    and has never had an ACTIVE member, so the old comparison against 'ACTIVE' was true for
    EVERY organization on the platform — including fully approved ones. No cinema could reach
    READY, ever.

    It survived because the unit fixture said `status: 'ACTIVE'`, a value the column cannot
    hold. The same shape of mistake as the timezone work: a fixture that agrees with the code
    rather than with the database proves only that the two agree. It took a live walk through
    a real organization to see it.

    Approval is also NOT the theater's to grant — only an admin review sets the status — so
    this names its owner rather than sending them to a settings page that cannot do it. The
    old fix path pointed at `/organizer/settings`, which can edit the public profile and
    nothing else.
  */
  if (f.organization.status === 'PENDING') {
    c.push({
      section: 'BUSINESS',
      code: 'ORG_NOT_ACTIVE',
      level: 'BLOCKED',
      message:
        'This organization has not been approved yet. ETicketsGo reviews and approves it — contact support if it has been pending for long.',
      fixPath: null,
    });
  } else if (f.organization.status !== 'APPROVED') {
    c.push({
      section: 'BUSINESS',
      code: 'ORG_NOT_ACTIVE',
      level: 'BLOCKED',
      message: `This organization is ${f.organization.status.toLowerCase()}. ETicketsGo owns that decision — contact support to discuss it.`,
      fixPath: null,
    });
  } else {
    c.push(ok('BUSINESS', 'ORG_ACTIVE', 'Organization is approved.'));
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

  /*
    ── Pricing ───────────────────────────────────────────────────────────────────

    What a customer pays is the SHOW's price, not the layout's. A seat category's
    `basePriceMinor` is only the default a new show is created from; once scheduled, the
    show carries its own price and can be changed without touching the room.

    So the blocking question is about future sellable shows, not about the template. A
    cinema whose layout says ₹200 while tomorrow's show sells at ₹0 was previously reported
    READY here — the check was looking at the wrong row.

    The template still matters, because it is what the NEXT show will be created from, but
    an unpriced template only warns: it misprices shows that do not exist yet.
  */
  if (f.futureShowsWithZeroPrice > 0) {
    c.push({
      section: 'PRICING',
      code: 'SHOWS_PRICED_AT_ZERO',
      level: 'BLOCKED',
      message: `${f.futureShowsWithZeroPrice} upcoming show${
        f.futureShowsWithZeroPrice === 1 ? '' : 's'
      } would sell a seat for nothing. Set a price before those shows open.`,
      fixPath: schedulePath,
    });
  } else if (f.pricedCategories === 0) {
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
      } no default price, so shows scheduled from ${
        f.unpricedCategories === 1 ? 'it' : 'them'
      } would start at zero.`,
      fixPath: cinemaPath,
    });
  } else {
    c.push(
      ok(
        'PRICING',
        'PRICING_SET',
        f.futureShowsPriced > 0
          ? `Every seat category is priced, and all ${f.futureShowsPriced} upcoming shows carry a price.`
          : 'Every seat category is priced.',
      ),
    );
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
        'No active convenience fee rule. Tickets will sell with no booking fee — intended for a pilot, but confirm it with ETicketsGo before opening.',
      // No organizer-reachable screen exists. This previously pointed at `/admin/fees`, which
      // is not a route at all AND lives in an application a theater operator cannot open — a
      // dead link dressed up as an action. Null is honest: the UI says who owns this instead.
      fixPath: null,
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
      message:
        'No INR payment route is configured, so checkout cannot complete. ETicketsGo configures payment routing — contact support.',
      // Platform configuration, not the theater's. Linking an operator into the admin app
      // they cannot sign in to is worse than telling them who to ask.
      fixPath: null,
    });
  } else {
    c.push(ok('PAYMENTS', 'INR_ROUTE', 'An INR payment route is available.'));
  }

  c.push(...evaluatePaymentProvider(f.payments));

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
