/**
 * Which cinema pricing rule governs one priced order, and why.
 *
 * ── WHY THIS IS ONE PURE FUNCTION ──────────────────────────────────────────────────
 * The alternative is `if (state === 'AP')` in checkout, again in the organizer console,
 * again in the show API, again in the mobile client — four copies of a legal position, each
 * free to disagree, none of them testable without standing up a booking. The platform has
 * already learned this twice: fee tiers and tax rules are both data for the same reason,
 * and both had drifted before they were centralised.
 *
 * So the whole of it is here. Rows in, a decision out, no I/O and no clock of its own.
 *
 * ── WHAT THIS FILE DOES NOT KNOW ───────────────────────────────────────────────────
 * Not one rupee of any government order. Not that Andhra Pradesh charges ₹5, not that
 * Telangana charges anything, not what a ceiling is anywhere. It knows the SHAPE such an
 * order takes — a per-ticket charge that is either inside the price or added to it, an
 * online fee that may be capped or forbidden, a price band — and reads the numbers from
 * rows an administrator entered against a cited reference.
 */
import type {
  CinemaFormat,
  ClimateType,
  LocalBodyType,
  MaintenanceTreatment,
  OnlineFeePolicy,
  PricingComplianceStatus,
} from '@eticketsgo/shared-types';

/** A policy row, as much of it as resolution needs. */
export interface PolicyRow {
  id: string;
  version: number;
  country: string;
  region: string;
  district: string;
  city: string;
  currency: string;
  localBodyType: LocalBodyType | null;
  cinemaFormat: CinemaFormat | null;
  climateType: ClimateType | null;
  seatCategory: string | null;
  maintenanceChargeMinor: number;
  maintenanceTreatment: MaintenanceTreatment;
  maintenanceTaxCategory: string | null;
  onlineFeePolicy: OnlineFeePolicy;
  onlineFeeCapMinor: number | null;
  ticketPriceMinMinor: number | null;
  ticketPriceMaxMinor: number | null;
  ticketPriceRule: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  regulatoryReference: string;
}

/** Where and what is being sold. Everything a rule may match on. */
export interface PolicyContext {
  country: string | null;
  region: string | null;
  district: string | null;
  city: string | null;
  currency: string;
  localBodyType: LocalBodyType | null;
  cinemaFormat: CinemaFormat | null;
  climateType: ClimateType | null;
  /** Seat/ticket classes in the cart, so a seat-specific rule can be matched. */
  seatCategories: string[];
  /** The business date the order is priced at. Supplied, never `new Date()` in here. */
  at: Date;
}

export interface PolicyResolution {
  status: PricingComplianceStatus;
  policy: PolicyRow | null;
  /**
   * Why this outcome, in one sentence, for an admin screen and an audit entry.
   *
   * Explainability is a requirement rather than a nicety: "your booking was refused" with
   * no reason is unactionable for the organizer, and a compliance question six months later
   * asks exactly this.
   */
  explanation: string;
  /** How specific the winning rule was. Higher beats lower; see `specificity`. */
  specificity: number;
}

const WILDCARD = '*';

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a?.trim() && b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase());

/** A scope field matches when it is the wildcard or equals the context, case-insensitively. */
const scopeMatches = (rule: string, value: string | null): boolean =>
  rule === WILDCARD || same(rule, value);

/**
 * How specific a rule is, as a single comparable number.
 *
 * Weighted so that no combination of broader fields can outrank one narrower field — the
 * gaps double, which is what makes precedence deterministic rather than a matter of how
 * many wildcards happened to be filled in. Order, narrowest first:
 *
 *     seat category > climate > format > local body > city > district > region > country
 *
 * Two rules with the SAME specificity for the same context is ambiguity, and the resolver
 * refuses rather than picking one; see `resolvePolicy`.
 */
export function specificity(rule: PolicyRow): number {
  return (
    (rule.seatCategory ? 128 : 0) +
    (rule.climateType ? 64 : 0) +
    (rule.cinemaFormat ? 32 : 0) +
    (rule.localBodyType ? 16 : 0) +
    (rule.city !== WILDCARD ? 8 : 0) +
    (rule.district !== WILDCARD ? 4 : 0) +
    (rule.region !== WILDCARD ? 2 : 0) +
    (rule.country !== WILDCARD ? 1 : 0)
  );
}

/** Whether a rule's own conditions all hold for this context. */
function applies(rule: PolicyRow, ctx: PolicyContext): boolean {
  if (!scopeMatches(rule.country, ctx.country)) return false;
  if (!scopeMatches(rule.region, ctx.region)) return false;
  if (!scopeMatches(rule.district, ctx.district)) return false;
  if (!scopeMatches(rule.city, ctx.city)) return false;
  if (!scopeMatches(rule.currency, ctx.currency)) return false;

  // A rule that names a classification requires it. A cinema that has not been classified
  // therefore does not match, and that is reported as INVALID_CINEMA_CLASSIFICATION rather
  // than as "no policy" — the difference tells an operator what to go and fix.
  if (rule.localBodyType && rule.localBodyType !== ctx.localBodyType) return false;
  if (rule.cinemaFormat && rule.cinemaFormat !== ctx.cinemaFormat) return false;
  if (rule.climateType && rule.climateType !== ctx.climateType) return false;
  if (rule.seatCategory && !ctx.seatCategories.some((c) => same(c, rule.seatCategory))) {
    return false;
  }

  // Effective-dated. `effectiveFrom` is inclusive and `effectiveTo` exclusive, so a policy
  // ending the instant the next begins leaves no gap and no overlap.
  if (ctx.at < rule.effectiveFrom) return false;
  if (rule.effectiveTo && ctx.at >= rule.effectiveTo) return false;
  return true;
}

/** Whether any ACTIVE rule claims this country at all — i.e. is this market regulated. */
export function isRegulated(active: PolicyRow[], ctx: PolicyContext): boolean {
  return active.some((r) => scopeMatches(r.country, ctx.country));
}

/**
 * Resolve one policy for one order.
 *
 * `active` must already be filtered to ACTIVE rows; DRAFT and DISABLED policies price
 * nothing, and SUPERSEDED ones are history. Passing the filter in rather than doing it here
 * keeps this function free of any opinion about storage.
 */
export function resolvePolicy(active: PolicyRow[], ctx: PolicyContext): PolicyResolution {
  const regulated = isRegulated(active, ctx);
  if (!regulated) {
    /*
      Nothing claims this country, so nothing is regulated and pricing proceeds exactly as it
      did before this table existed. This is what keeps every non-cinema event, and every
      market nobody has written an order for, working unchanged — and it is a DECLARATION,
      not a guess: regulation begins when somebody enters a row.
    */
    return {
      status: 'NOT_REGULATED',
      policy: null,
      explanation: `No active cinema pricing policy covers ${ctx.country ?? 'this country'}; ordinary platform pricing applies.`,
      specificity: -1,
    };
  }

  const matches = active.filter((r) => applies(r, ctx));
  if (matches.length === 0) {
    /*
      The country IS regulated and nothing matched. Never fall through to the platform's own
      fee schedule here: that is precisely the silent non-compliance this whole mechanism
      exists to prevent.

      Distinguish a cinema that has not been classified from one in a genuinely unwritten
      jurisdiction, because they are different jobs for different people.
    */
    const classificationWanted = active.some(
      (r) =>
        scopeMatches(r.country, ctx.country) &&
        scopeMatches(r.region, ctx.region) &&
        ((r.climateType && !ctx.climateType) ||
          (r.cinemaFormat && !ctx.cinemaFormat) ||
          (r.localBodyType && !ctx.localBodyType)),
    );
    return classificationWanted
      ? {
          status: 'INVALID_CINEMA_CLASSIFICATION',
          policy: null,
          explanation:
            'This jurisdiction prices by cinema classification, and this cinema has not been classified. Set its format, climate type or local body.',
          specificity: -1,
        }
      : {
          status: 'POLICY_NOT_FOUND',
          policy: null,
          explanation: `${ctx.country} has active cinema pricing policies but none covers ${[ctx.region, ctx.district, ctx.city].filter(Boolean).join(' / ') || 'this location'} on ${ctx.at.toISOString().slice(0, 10)}.`,
          specificity: -1,
        };
  }

  const best = Math.max(...matches.map(specificity));
  const winners = matches.filter((r) => specificity(r) === best);

  if (winners.length > 1) {
    /*
      Two equally specific rules for one order. There is no correct answer to pick — either
      is defensible and the choice would be an accident of row order, so the same cinema
      could price differently between two deploys. Refuse and name them.
    */
    return {
      status: 'POLICY_CONFIGURATION_ERROR',
      policy: null,
      explanation: `${winners.length} equally specific policies match this order (${winners
        .map((w) => w.regulatoryReference)
        .join('; ')}). Supersede or narrow all but one.`,
      specificity: best,
    };
  }

  const policy = winners[0];

  /*
    An unresolved maintenance treatment is not a pricing instruction.

    Knowing the amount is not knowing what to do with it: ₹5 UNCONFIRMED either sits inside
    the ticket price or on top of it, and the two differ by ₹5 per ticket in the customer's
    favour or the state's. The database refuses to make such a policy ACTIVE, and this
    refuses it again — a row can reach ACTIVE through a console or a future screen, and the
    money has to be safe on every path rather than on the one somebody remembered.
  */
  if (policy.maintenanceTreatment === 'UNCONFIRMED') {
    return {
      status: 'POLICY_CONFIGURATION_ERROR',
      policy,
      explanation: `Policy ${policy.regulatoryReference} records a maintenance charge but not whether it is included in the ticket price or added to it. It cannot price an order until that is resolved.`,
      specificity: best,
    };
  }

  // A cap is the entire content of a CAPPED policy. Without one it is an unlimited fee
  // wearing a limit's name, which is worse than no policy because it looks configured.
  if (policy.onlineFeePolicy === 'CAPPED' && policy.onlineFeeCapMinor == null) {
    return {
      status: 'POLICY_CONFIGURATION_ERROR',
      policy,
      explanation: `Policy ${policy.regulatoryReference} caps the online fee but records no cap.`,
      specificity: best,
    };
  }

  const matchedOn = `${policy.regulatoryReference} (v${policy.version}), effective ${policy.effectiveFrom.toISOString().slice(0, 10)}, matched on ${describeScope(policy)}.`;

  /*
    ── A MATCHED POLICY IS NOT AUTOMATICALLY A SETTLED ONE ──────────────────────────
    `REQUIRES_APPROVAL` is a real, correct, matched policy whose online-fee position nobody
    has confirmed. Reporting that as COMPLIANT would hide the single most important fact
    about the market from the organizer's compliance panel, from the booking snapshot and
    from anyone auditing later — and it is the state Andhra Pradesh and Telangana ship in.

    It still prices and still sells: the fee is suppressed to zero, which cannot overcharge
    anybody. Only the LABEL differs, and the label is the point.
  */
  if (policy.onlineFeePolicy === 'REQUIRES_APPROVAL') {
    return {
      status: 'REQUIRES_APPROVAL',
      policy,
      explanation: `${matchedOn} The online booking fee for this jurisdiction is pending regulatory confirmation, so no platform fee is charged.`,
      specificity: best,
    };
  }

  return { status: 'COMPLIANT', policy, explanation: matchedOn, specificity: best };
}

/** The scope a rule matched on, for an audit line and an admin screen. */
export function describeScope(rule: PolicyRow): string {
  const parts = [
    rule.country !== WILDCARD ? rule.country : null,
    rule.region !== WILDCARD ? rule.region : null,
    rule.district !== WILDCARD ? rule.district : null,
    rule.city !== WILDCARD ? rule.city : null,
    rule.localBodyType,
    rule.cinemaFormat,
    rule.climateType,
    rule.seatCategory,
  ].filter(Boolean);
  return parts.length ? parts.join(' / ') : 'any cinema';
}
