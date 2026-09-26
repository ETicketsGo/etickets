import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { AppException, ErrorCodes } from '../common/errors';
import { GROUPABLE } from './admin-grouping.service';

/**
 * Scoping an admin list to one group of its grouped summary.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * `AdminGroupingService` answers "where should I look" - one row per country, organizer or
 * event with a count and money. That answer is only useful if the next click narrows the list
 * underneath to that group, and a summary whose rows cannot be clicked is a dead end dressed as
 * a feature.
 *
 * So every grouped queue accepts the same two parameters, and they mean the same thing on all of
 * them. Six lists in five modules translate a group into their own `where`; this is the one
 * place that knows how, so "country" cannot come to mean the venue's country on one queue and
 * the organization's on the next.
 *
 * ── WHAT THE TWO PARAMETERS MEAN TOGETHER ──────────────────────────────────────────
 * `groupBy` alone is the console's NORMAL state: a grouping has been chosen, the summary is on
 * screen, and no group has been clicked yet. The list stays whole. `groupKey` is what narrows it,
 * and `groupKey` without a `groupBy` is the incoherent pair, so that one is refused.
 *
 * The first version of this had it backwards - `groupKey` was required whenever `groupBy` was
 * given, on the reasoning that a UI which forgot to send it should fail loudly rather than
 * quietly. A browser showed what that actually did: the instant an operator chose "Country" from
 * the dropdown, every list on the platform answered 400 and emptied itself. The state I had
 * treated as a caller's mistake is the state the screen is in most of the time.
 *
 * ── THE GROUP WITH NO VALUE ────────────────────────────────────────────────────────
 * The literal `__none__` selects the group whose key is null - the "Not recorded" row an
 * unapproved organization lands in. It needs a sentinel at all because absent now means "not
 * narrowed", and it cannot be the empty string: the web client's `qs()` drops any parameter that
 * is empty, so `groupKey: ''` would never leave the browser. `__none__` survives serialisation
 * and cannot collide, because no country is called that and no cuid looks like it.
 */
export const GROUP_KEY_NONE = '__none__';

export const groupScopeFields = {
  /** Which grouping the summary is showing. On its own it narrows nothing. */
  groupBy: z.string().trim().min(1).optional(),
  /** The group to narrow to; `__none__` for the group with no value. Absent means "all groups". */
  groupKey: z.string().optional(),
};

export interface GroupScope {
  groupBy?: string;
  groupKey?: string;
}

/**
 * How each resource reaches each grouping in Prisma.
 *
 * The relation paths mirror `SHAPES` in `admin-grouping.service.ts` - the SQL there and the
 * `where` here must select the same rows, or a group would report a count the list does not
 * show. `group-scope.spec.ts` holds them to that by proving every declared grouping has a path.
 */
type ScopeBuilder = (key: string | null) => Record<string, unknown>;

const SCOPES: Record<string, Record<string, ScopeBuilder>> = {
  bookings: {
    country: (k) => ({ event: { venue: { country: k } } }),
    organizer: (k) => ({ organizationId: k }),
    event: (k) => ({ eventId: k }),
  },
  payments: {
    country: (k) => ({ booking: { event: { venue: { country: k } } } }),
    organizer: (k) => ({ booking: { organizationId: k } }),
    event: (k) => ({ booking: { eventId: k } }),
  },
  refunds: {
    // A refund's own `organizationId` is authoritative; its country and event come through the
    // booking, because a Refund row records neither.
    country: (k) => ({ booking: { event: { venue: { country: k } } } }),
    organizer: (k) => ({ organizationId: k }),
    event: (k) => ({ booking: { eventId: k } }),
  },
  events: {
    country: (k) => ({ venue: { country: k } }),
    organizer: (k) => ({ organizationId: k }),
  },
  organizers: {
    country: (k) => ({ registeredCountry: k }),
  },
  settlements: {
    country: (k) => ({ event: { venue: { country: k } } }),
    organizer: (k) => ({ organizationId: k }),
    event: (k) => ({ eventId: k }),
    currency: (k) => ({ currency: k }),
  },
};

/**
 * The `where` fragment for one group, or `{}` when nothing is being narrowed.
 *
 * An unrecognised `groupBy` is refused rather than ignored: a list that dropped it would show
 * every row while its summary said one group was selected, and nothing on screen would say which
 * of the two was lying. But a `groupBy` with no key is not a mistake — it is the summary being on
 * screen with nothing clicked — so that returns `{}` and the list stays whole.
 */
export function groupScopeWhere(
  resource: keyof typeof SCOPES,
  scope: GroupScope,
): Record<string, unknown> {
  if (!scope.groupBy) {
    if (scope.groupKey !== undefined) {
      // The genuinely incoherent pair: a group to narrow to, and no grouping it belongs to. There
      // is no reading of that which selects anything, so it cannot be answered with rows.
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A groupKey needs the groupBy it belongs to.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return {};
  }

  const builders = SCOPES[resource];
  const build = builders?.[scope.groupBy];
  if (!build) {
    const supported = Object.keys(builders ?? {});
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      `${resource} cannot be grouped by ${scope.groupBy}. Try: ${supported.join(', ')}.`,
      HttpStatus.BAD_REQUEST,
    );
  }
  // A grouping chosen with no group clicked yet: the summary narrows nothing on its own.
  if (scope.groupKey === undefined) return {};

  return build(scope.groupKey === GROUP_KEY_NONE ? null : scope.groupKey);
}

/** Exported so the spec can hold SCOPES and GROUPABLE to the same set of groupings. */
export const GROUP_SCOPES = SCOPES;
export const GROUP_SCOPE_RESOURCES = GROUPABLE;
