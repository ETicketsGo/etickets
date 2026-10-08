/**
 * Who operates ETicketsGo in each market, and which version of each policy applies there.
 *
 * -- WHY THIS IS ONE FILE ---------------------------------------------------------------
 * The same reasoning as `markets.ts`, which already exists so that country facts are not
 * retyped per feature. A legal document has three properties that get scattered the moment
 * they live in a React component: which jurisdiction it is for, which version it is, and
 * when it took effect. Scattered, there is no way to answer the only question an audit
 * actually asks - "which text did this person agree to?" - because the component has been
 * edited since and kept no version.
 *
 * So policies are identified here, resolved here, and referenced everywhere else by an
 * opaque label. Old versions stay in the registry after they are superseded, because a
 * consent record from last year points at one.
 *
 * -- WHAT THIS FILE IS NOT ---------------------------------------------------------------
 * It is not legal advice and it does not hold the policy TEXT. It holds identity and
 * resolution. The text lives with the pages that render it, which is where a reviewer and a
 * translator both expect to find it.
 */

/** A legal person that operates the platform in a market. Never guessed. */
export interface LegalEntity {
  /** The registered name, exactly as it is written on the registration. */
  legalName: string;
  /** ISO-3166 alpha-2 of the country the entity is registered in. */
  country: string;
}

/**
 * The operating entities, by the market a transaction belongs to.
 *
 * Only countries where an entity actually exists appear here. Everything else resolves to
 * `PLATFORM_OPERATOR` below, which is the entity behind the brand itself - the honest answer
 * for a visitor in a market we have not incorporated in, and the one the brand line
 * "Operated by DeepTrics LLC" refers to.
 */
export const LEGAL_ENTITIES: Readonly<Record<string, LegalEntity>> = Object.freeze({
  US: { legalName: 'DeepTrics LLC', country: 'US' },
  IN: { legalName: 'Deeptrics Software Solution Pvt Ltd', country: 'IN' },
});

/** The entity behind the ETicketsGo brand, and the fallback for any unincorporated market. */
export const PLATFORM_OPERATOR: LegalEntity = LEGAL_ENTITIES.US;

/**
 * The entity a buyer in `country` is dealing with.
 *
 * Takes the ISO code or the country name, because callers hold both: a `Venue.country` is a
 * name, a market code is a code. Unknown or absent resolves to the platform operator rather
 * than to nothing, since somebody is always the counterparty.
 */
export function legalEntityFor(country: string | null | undefined): LegalEntity {
  const needle = (country ?? '').trim().toLowerCase();
  if (!needle) return PLATFORM_OPERATOR;
  if (needle === 'us' || needle === 'usa' || needle === 'united states') return LEGAL_ENTITIES.US;
  if (needle === 'in' || needle === 'india') return LEGAL_ENTITIES.IN;
  return PLATFORM_OPERATOR;
}

/** The documents the registry knows how to resolve. */
export type PolicyType = 'TERMS' | 'PRIVACY' | 'SMS' | 'REFUNDS' | 'COOKIES';

/**
 * A jurisdiction a policy can be written for.
 *
 * `GLOBAL` is a real entry, not a gap: it is the text that applies where no country-specific
 * supplement has been written, and it is what every unlisted market resolves to.
 */
export type PolicyJurisdiction = 'GLOBAL' | 'US' | 'IN' | 'CA';

export interface Policy {
  type: PolicyType;
  jurisdiction: PolicyJurisdiction;
  /** Monotonic per (type, jurisdiction). Never reused, never edited in place. */
  version: number;
  /** ISO date the version took effect. */
  effectiveDate: string;
  /**
   * `current` is served; `superseded` is kept only so an old consent record still resolves.
   * A superseded policy is never returned by `getApplicablePolicy`.
   */
  status: 'current' | 'superseded';
}

/**
 * Every policy version the platform has had.
 *
 * All at v1 and all effective the same day, because this is the first versioned set - that
 * is a fact about our history, not a placeholder. When a document changes, add a new row and
 * mark the old one `superseded`; do not edit a row, because consent records point at it.
 */
export const POLICY_REGISTRY: readonly Policy[] = Object.freeze([
  {
    type: 'TERMS',
    jurisdiction: 'GLOBAL',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },
  { type: 'TERMS', jurisdiction: 'US', version: 1, effectiveDate: '2026-10-06', status: 'current' },
  { type: 'TERMS', jurisdiction: 'IN', version: 1, effectiveDate: '2026-10-06', status: 'current' },
  { type: 'TERMS', jurisdiction: 'CA', version: 1, effectiveDate: '2026-10-06', status: 'current' },

  {
    type: 'PRIVACY',
    jurisdiction: 'GLOBAL',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'US',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'IN',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'CA',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },

  /*
    SMS has a US entry because the US is where the messaging programme is registered and
    where the disclosure requirements are most specific. The others resolve to GLOBAL until
    a market has its own programme - India's is gated on DLT registration, not on text.
  */
  {
    type: 'SMS',
    jurisdiction: 'GLOBAL',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },
  { type: 'SMS', jurisdiction: 'US', version: 1, effectiveDate: '2026-10-06', status: 'current' },

  {
    type: 'REFUNDS',
    jurisdiction: 'GLOBAL',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },
  {
    type: 'REFUNDS',
    jurisdiction: 'IN',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },

  {
    type: 'COOKIES',
    jurisdiction: 'GLOBAL',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'current',
  },
]);

/** The jurisdictions the registry can resolve to, for a country selector. */
export const POLICY_JURISDICTIONS: readonly PolicyJurisdiction[] = ['US', 'IN', 'CA', 'GLOBAL'];

/** Normalise anything a caller holds - a code, a name - to a jurisdiction. */
export function policyJurisdictionFor(country: string | null | undefined): PolicyJurisdiction {
  const needle = (country ?? '').trim().toLowerCase();
  if (needle === 'us' || needle === 'usa' || needle === 'united states') return 'US';
  if (needle === 'in' || needle === 'india') return 'IN';
  if (needle === 'ca' || needle === 'canada') return 'CA';
  return 'GLOBAL';
}

/**
 * The policy that applies to `country`, or the global one when that market has no supplement.
 *
 * THE FALLBACK IS THE POINT. Resolving to `undefined` for an unlisted market would mean a
 * page with no terms on it, which is worse than terms written for everybody. Every type has
 * a GLOBAL row for exactly that reason, and this returns a `Policy` rather than
 * `Policy | undefined` so callers cannot forget the case.
 */
export function getApplicablePolicy(type: PolicyType, country?: string | null): Policy {
  const jurisdiction = policyJurisdictionFor(country);
  const current = POLICY_REGISTRY.filter((p) => p.type === type && p.status === 'current');
  return (
    current.find((p) => p.jurisdiction === jurisdiction) ??
    current.find((p) => p.jurisdiction === 'GLOBAL') ??
    // Unreachable while every type keeps a GLOBAL row; the catalogue test asserts that.
    (() => {
      throw new Error(`No GLOBAL policy registered for ${type}`);
    })()
  );
}

/**
 * The stable label stored on a consent record, e.g. `TERMS/US/v1`.
 *
 * Deliberately a string rather than a foreign key: it has to survive in a row that outlives
 * any table of policies, and it has to be readable by a person reviewing an audit export
 * without joining anything.
 */
export function policyVersionLabel(policy: Policy): string {
  return `${policy.type}/${policy.jurisdiction}/v${policy.version}`;
}

/** Resolve a stored label back to its policy, including superseded ones. */
export function policyFromLabel(label: string): Policy | null {
  const m = /^([A-Z]+)\/([A-Z]+)\/v(\d+)$/.exec(label.trim());
  if (!m) return null;
  return (
    POLICY_REGISTRY.find(
      (p) => p.type === m[1] && p.jurisdiction === m[2] && p.version === Number(m[3]),
    ) ?? null
  );
}
