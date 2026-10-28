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

import { marketFor } from './markets';

/** A legal person that operates the platform in a market. Never guessed. */
export interface LegalEntity {
  /** The registered name, exactly as it is written on the registration. */
  legalName: string;
  /**
   * The abbreviated form the owner uses in short lines such as the footer copyright, e.g.
   * "Pvt Ltd" for "Private Limited". The same company, never a different one.
   */
  shortName: string;
  /** ISO-3166 alpha-2 of the country the entity is registered in. */
  country: string;
  /**
   * Company-record facts, `null` until the owner supplies them from the company's own
   * records. Pages render a field only when it is set, so a missing value is visibly absent
   * rather than invented. Do not fill one in from a web search or to make a page look
   * finished: a wrong CIN on a page a carrier reviews is worse than no CIN.
   */
  registeredOffice: string | null;
  /** India: the Corporate Identification Number from the MCA certificate of incorporation. */
  companyId: string | null;
  /** India: the GSTIN. Only where the entity is GST-registered. */
  taxId: string | null;
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
  US: {
    legalName: 'DeepTrics LLC',
    shortName: 'DeepTrics LLC',
    country: 'US',
    registeredOffice: null,
    companyId: null,
    taxId: null,
  },
  /*
    The name as registered on the DLT portal (Principal Entity, docs/notifications/
    INDIA-DLT-TEMPLATES.md) and as the owner states it: "ETicketsGo is operated in India by
    DeepTrics Software Solutions Private Limited". This row used to read "Deeptrics Software
    Solution Pvt Ltd" - a lower-case t and a missing s. A carrier compares the website against
    the DLT record character for character, so the spelling here is the one on that record.
  */
  IN: {
    legalName: 'DeepTrics Software Solutions Private Limited',
    shortName: 'DeepTrics Software Solutions Pvt Ltd',
    country: 'IN',
    registeredOffice: null,
    companyId: null,
    taxId: null,
  },
});

/** The company that operates ETicketsGo in India. The footer and the India pages name it. */
export const INDIA_OPERATOR: LegalEntity = LEGAL_ENTITIES.IN;

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
  return entityForCountry(country) ?? PLATFORM_OPERATOR;
}

/**
 * The entity incorporated in `country`, or null when we have none there.
 *
 * Unlike `legalEntityFor`, this does not fall back. The resolver below needs to know the
 * difference between "this transaction is in India" and "this transaction is somewhere we
 * have no company", so it can move on to the next signal.
 */
export function entityForCountry(country: string | null | undefined): LegalEntity | null {
  const code = marketFor(country)?.code;
  return code ? (LEGAL_ENTITIES[code] ?? null) : null;
}

/**
 * The entity whose merchant account takes payment in `currency`, or null when no currency
 * belongs to one entity alone.
 *
 * This mirrors the payment routing and does not decide it: INR routes to the Indian gateway
 * account (Razorpay) and USD to the US one (Stripe). Every other currency returns null here
 * and is resolved by the next signal, so this table cannot drift into a second routing rule.
 */
export function entityForCurrency(currency: string | null | undefined): LegalEntity | null {
  const c = (currency ?? '').trim().toUpperCase();
  if (c === 'INR') return LEGAL_ENTITIES.IN;
  if (c === 'USD') return LEGAL_ENTITIES.US;
  return null;
}

/**
 * A merchant of record, as callers hold it: an entity country code ("IN", "US"), or the
 * payment provider that took the money ("RAZORPAY", "STRIPE", "RAZORPAY_BILLING", ...).
 * Anything else, including the test double, is not evidence and returns null.
 */
export function entityForMerchantOfRecord(mor: string | null | undefined): LegalEntity | null {
  const m = (mor ?? '').trim().toUpperCase();
  if (!m) return null;
  if (m.startsWith('RAZORPAY')) return LEGAL_ENTITIES.IN;
  if (m.startsWith('STRIPE')) return LEGAL_ENTITIES.US;
  return LEGAL_ENTITIES[m] ?? null;
}

/** Which signal decided an entity. Recorded so a reviewer can see why a document names it. */
export type LegalEntityBasis =
  'MERCHANT_OF_RECORD' | 'TRANSACTION_COUNTRY' | 'CURRENCY' | 'MARKET' | 'DEFAULT';

export interface ResolveLegalEntityInput {
  /** Who actually took the money: an entity code or a payment provider key. Strongest. */
  merchantOfRecord?: string | null;
  /** Where the transaction happened: a venue's country, a billing account's country. */
  transactionCountry?: string | null;
  /** The transaction currency. Follows the payment routing (INR India, USD United States). */
  currency?: string | null;
  /** The market a page is showing. Weakest: it says what a reader is browsing, not a sale. */
  market?: string | null;
}

export interface LegalEntityResolution {
  entity: LegalEntity;
  basis: LegalEntityBasis;
}

/**
 * THE way to ask which DeepTrics company a transaction or a page is with.
 *
 * -- THE ORDER, AND WHY ---------------------------------------------------------------
 * 1. Merchant of record. Who took the money is the answer, when we know it.
 * 2. Transaction country. A booking at a venue in India, a billing account in India.
 * 3. Currency. The payment routing sends INR to the Indian account and USD to the US one,
 *    so the currency says whose account the money landed in when no country is known.
 * 4. Market. What the reader is browsing. Only for pages, never for a financial record.
 * 5. The platform operator (DeepTrics LLC), the entity behind the brand itself.
 *
 * The first signal that names an entity wins. A signal for a country where we have no
 * company (Canada, say) is skipped rather than allowed to stop the search.
 *
 * Changing this does not change payment routing, merchant accounts, tax registrations or who
 * settles a payout. It only decides the NAME printed on a document or a page.
 */
export function resolveLegalEntity(input: ResolveLegalEntityInput): LegalEntityResolution {
  const steps: [LegalEntityBasis, LegalEntity | null][] = [
    ['MERCHANT_OF_RECORD', entityForMerchantOfRecord(input.merchantOfRecord)],
    ['TRANSACTION_COUNTRY', entityForCountry(input.transactionCountry)],
    ['CURRENCY', entityForCurrency(input.currency)],
    ['MARKET', entityForCountry(input.market)],
  ];
  for (const [basis, entity] of steps) if (entity) return { entity, basis };
  return { entity: PLATFORM_OPERATOR, basis: 'DEFAULT' };
}

/**
 * The entity a PUBLIC page should name for the market a reader selected, or null when the
 * market is unknown or is one where we have no company.
 *
 * Null is deliberate. A page with no market must not guess: it names both companies (see
 * `NEUTRAL_OPERATOR_SENTENCE`), which is true wherever it is read. It never falls back to an
 * IP-derived country on its own; callers pass a market the reader chose.
 */
export function publicLegalEntity(market: string | null | undefined): LegalEntity | null {
  return entityForCountry(market);
}

/** "India", "the United States": the place an entity operates the platform in, in a sentence. */
const OPERATING_REGION: Readonly<Record<string, string>> = Object.freeze({
  IN: 'India',
  US: 'the United States',
});

/**
 * The public line for one entity, verbatim as the owner wrote it:
 *   "ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited."
 *   "ETicketsGo is operated in the United States by DeepTrics LLC."
 *
 * English. The storefront and the email read the same sentence from the i18n catalogue
 * (`common.legalEntity`), and a test holds the two identical.
 */
export function operatorSentence(entity: LegalEntity): string {
  return `ETicketsGo is operated in ${OPERATING_REGION[entity.country] ?? entity.country} by ${entity.legalName}.`;
}

/** The line for a reader whose market is unknown: both companies, each where it operates. */
export const NEUTRAL_OPERATOR_SENTENCE = `ETicketsGo is operated in India by ${LEGAL_ENTITIES.IN.legalName} and in the United States by ${LEGAL_ENTITIES.US.legalName}.`;

/** The public line for a selected market, or the neutral one when it names no entity. */
export function publicOperatorSentence(market: string | null | undefined): string {
  const entity = publicLegalEntity(market);
  return entity ? operatorSentence(entity) : NEUTRAL_OPERATOR_SENTENCE;
}

/**
 * The platform operator as stored on a NEW financial document, so the name survives later
 * changes to this file. A document issued before this field existed has none, and keeps
 * rendering exactly as it was issued.
 */
export interface DocumentOperator {
  legalName: string;
  /** ISO-3166 alpha-2 of the entity. */
  country: string;
  basis: LegalEntityBasis;
}

export function documentOperator(input: ResolveLegalEntityInput): DocumentOperator {
  const { entity, basis } = resolveLegalEntity(input);
  return { legalName: entity.legalName, country: entity.country, basis };
}

/** The documents the registry knows how to resolve. */
export type PolicyType = 'TERMS' | 'PRIVACY' | 'SMS' | 'REFUNDS' | 'COOKIES' | 'MARKETING';

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
    status: 'superseded',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'GLOBAL',
    version: 2,
    effectiveDate: '2026-10-25',
    status: 'current',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'US',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'superseded',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'US',
    version: 2,
    effectiveDate: '2026-10-25',
    status: 'current',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'IN',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'superseded',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'IN',
    version: 2,
    effectiveDate: '2026-10-25',
    status: 'current',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'CA',
    version: 1,
    effectiveDate: '2026-10-06',
    status: 'superseded',
  },
  {
    type: 'PRIVACY',
    jurisdiction: 'CA',
    version: 2,
    effectiveDate: '2026-10-25',
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

  /*
    The words shown next to a marketing opt-in: who may email you, about what, and how to
    stop. One GLOBAL text for now. It is a separate type from PRIVACY because a consent row
    must name the exact text the person agreed to, and the privacy policy changes for
    reasons that have nothing to do with marketing. Consent rows for organizer news and for
    platform marketing email point here.
  */
  {
    type: 'MARKETING',
    jurisdiction: 'GLOBAL',
    version: 1,
    effectiveDate: '2026-10-27',
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
