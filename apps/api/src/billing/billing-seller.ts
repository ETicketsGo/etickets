import { HttpStatus } from '@nestjs/common';
import { INDIA_OPERATOR, indiaState } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * Who issues an Indian platform invoice (ETGB series), and whether it is a GST tax invoice.
 *
 * ── WHERE THE FACTS COME FROM ──────────────────────────────────────────────────────
 * The legal name is the India entity in shared-types `legal.ts` (INDIA_OPERATOR) - one
 * spelling for the footer, the DLT record and the invoice. The registration facts are
 * CONFIGURATION, never code, because only the owner can read them off the GST certificate:
 *
 *   BILLING_SELLER_GST_STATUS_IN  UNVERIFIED (default) | UNREGISTERED | REGISTERED
 *   BILLING_SELLER_GSTIN_IN       the 15-character GSTIN (format AND checksum are checked)
 *   BILLING_SELLER_SAC_IN         the 6-digit SAC (services accounting code, 99xxxx)
 *   BILLING_SELLER_ADDRESS_IN     the principal place of business
 *   PLATFORM_TAX_REGION           the seller's state (also decides CGST + SGST vs IGST)
 *
 * ── GST STATUS: DECLARED, NEVER DERIVED ─────────────────────────────────────────────
 * Only the owner can say whether the seller is registered under GST; it is never worked out
 * from turnover.
 *
 *   REGISTERED    GSTIN (checksum, same state as PLATFORM_TAX_REGION), SAC, address, state,
 *                 and GST from the active PLATFORM_SERVICES TaxRules on a "Tax invoice".
 *   UNREGISTERED  no GST on organizer billing (the rules are ignored for billing, not
 *                 deleted); an ordinary "Invoice" with the legal name, address and state and
 *                 the note GST_NOT_CHARGED_NOTE. Needs address and state only. A GSTIN set as
 *                 well is a contradiction: refused in PRODUCTION, never printed anywhere.
 *   UNVERIFIED    the default. PRODUCTION refuses Indian billing until the owner sets one of
 *                 the two above. Outside PRODUCTION it acts as REGISTERED when a GSTIN is set
 *                 (to test the tax invoice with TEST values) and as UNREGISTERED otherwise.
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────
 * In PRODUCTION an Indian checkout, quote and invoice is refused while the status is
 * UNVERIFIED or a fact it needs is missing, invalid or contradictory. The boot check refuses
 * the same thing when IN is in BILLING_LIVE_MARKETS. Outside PRODUCTION what is set is
 * printed, so QA can see the layout with TEST values.
 *
 * The facts are frozen onto the invoice when it is issued (documentJson.seller, with the
 * status as `gstStatus`); a later change of configuration never rewrites an issued invoice.
 */
export type SellerGstStatus = 'UNVERIFIED' | 'UNREGISTERED' | 'REGISTERED';
/** What an Indian sale is actually treated as. */
export type EffectiveSellerGstStatus = 'UNREGISTERED' | 'REGISTERED';

/** Printed on an invoice from an unregistered seller. Plain ASCII, per house rule. */
export const GST_NOT_CHARGED_NOTE = 'GST not charged: supplier not registered under GST.';

export interface IndiaSellerDetails {
  legalName: string;
  country: 'IN';
  /**
   * The status this sale is treated under (effectiveGstStatus); null only in PRODUCTION while
   * UNVERIFIED, which is refused before anything is sold or issued.
   */
  gstStatus: EffectiveSellerGstStatus | null;
  gstin: string | null;
  sac: string | null;
  address: string | null;
  /** The registered state's name, e.g. "Telangana". */
  state: string | null;
  /** Its GST state code, e.g. "36". */
  stateCode: string | null;
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The GSTIN check character over the first 14 characters (the published mod-36 scheme). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** True when a GSTIN has the GST shape and its 15th character is the right check character. */
export function gstinValid(value: string | null | undefined): boolean {
  const g = (value ?? '').trim().toUpperCase();
  return GSTIN_SHAPE.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

/** A SAC for a service: six digits starting 99 (chapter 99 of the GST tariff). */
export function sacValid(value: string | null | undefined): boolean {
  return /^99\d{4}$/.test((value ?? '').trim());
}

type Get = (name: string) => string | undefined | null;

const clean = (v: string | undefined | null): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

/** The declared status. Anything unset or unrecognised is UNVERIFIED. */
export function configuredGstStatus(get: Get): SellerGstStatus {
  const v = clean(get('BILLING_SELLER_GST_STATUS_IN'))?.toUpperCase();
  return v === 'REGISTERED' || v === 'UNREGISTERED' ? v : 'UNVERIFIED';
}

/**
 * What an Indian sale is treated as now. PRODUCTION: the declared status, or null (refused)
 * while UNVERIFIED. Elsewhere UNVERIFIED is REGISTERED when a GSTIN is set, else UNREGISTERED.
 */
export function effectiveGstStatus(get: Get): EffectiveSellerGstStatus | null {
  const declared = configuredGstStatus(get);
  if (declared !== 'UNVERIFIED') return declared;
  if (get('APP_ENV') === 'PRODUCTION') return null;
  return clean(get('BILLING_SELLER_GSTIN_IN')) ? 'REGISTERED' : 'UNREGISTERED';
}

/** The configured seller facts, as they would be frozen on an invoice now. */
export function indiaSellerDetails(get: Get): IndiaSellerDetails {
  const state = indiaState(clean(get('PLATFORM_TAX_REGION')));
  const gstStatus = effectiveGstStatus(get);
  // An unregistered seller has no GSTIN and no SAC on its invoice, whatever is configured.
  const registered = gstStatus !== 'UNREGISTERED';
  return {
    legalName: INDIA_OPERATOR.legalName,
    country: 'IN',
    gstStatus,
    gstin: registered ? (clean(get('BILLING_SELLER_GSTIN_IN'))?.toUpperCase() ?? null) : null,
    sac: registered ? clean(get('BILLING_SELLER_SAC_IN')) : null,
    address: clean(get('BILLING_SELLER_ADDRESS_IN')),
    state: state?.name ?? clean(get('PLATFORM_TAX_REGION')),
    stateCode: state?.code ?? null,
  };
}

/**
 * What stops Indian billing under the DECLARED status, by variable NAME only (never a value,
 * so the list is safe to log and to show in a boot error). Empty: ready. This is the
 * PRODUCTION standard: the boot check and the runtime guard use it.
 */
export function indiaSellerProblems(get: Get): string[] {
  const declared = configuredGstStatus(get);
  if (declared === 'UNVERIFIED') {
    return [
      'BILLING_SELLER_GST_STATUS_IN is UNVERIFIED (or not set): set it to REGISTERED or ' +
        'UNREGISTERED, as the GST registration actually stands.',
    ];
  }
  const d = indiaSellerDetails(get);
  const problems: string[] = [];
  const addressAndState = () => {
    if (!d.address) problems.push('BILLING_SELLER_ADDRESS_IN is not set.');
    else if (d.address.length < 10) {
      problems.push('BILLING_SELLER_ADDRESS_IN is too short to be a business address.');
    }
    if (!clean(get('PLATFORM_TAX_REGION'))) problems.push('PLATFORM_TAX_REGION is not set.');
    else if (!d.stateCode) {
      problems.push('PLATFORM_TAX_REGION is not an Indian state or union territory.');
    }
  };
  if (declared === 'UNREGISTERED') {
    if (clean(get('BILLING_SELLER_GSTIN_IN'))) {
      problems.push(
        'BILLING_SELLER_GSTIN_IN is set but BILLING_SELLER_GST_STATUS_IN is UNREGISTERED: an ' +
          'unregistered supplier has no GSTIN. Remove it, or declare REGISTERED.',
      );
    }
    addressAndState();
    return problems;
  }
  if (!d.gstin) problems.push('BILLING_SELLER_GSTIN_IN is not set.');
  else if (!gstinValid(d.gstin)) {
    problems.push('BILLING_SELLER_GSTIN_IN is not a valid GSTIN (format or check character).');
  }
  if (!d.sac) problems.push('BILLING_SELLER_SAC_IN is not set.');
  else if (!sacValid(d.sac)) {
    problems.push('BILLING_SELLER_SAC_IN is not a 6-digit service code starting 99.');
  }
  addressAndState();
  if (d.gstin && gstinValid(d.gstin) && d.stateCode && d.gstin.slice(0, 2) !== d.stateCode) {
    problems.push(
      'BILLING_SELLER_GSTIN_IN is registered in another state than PLATFORM_TAX_REGION ' +
        '(its first two digits are the state code).',
    );
  }
  return problems;
}

/**
 * Runtime guard: in PRODUCTION, refuses an Indian checkout, quote or invoice while the GST
 * status is UNVERIFIED or a fact it needs is missing, invalid or contradictory. Other
 * environments and other countries pass.
 */
export function assertIndiaSellerReady(get: Get, country: string | null | undefined): void {
  if ((country ?? '').toUpperCase() !== 'IN') return;
  if (get('APP_ENV') !== 'PRODUCTION') return;
  const problems = indiaSellerProblems(get);
  if (problems.length > 0) {
    throw new AppException(
      ErrorCodes.BILLING_NOT_ENABLED,
      configuredGstStatus(get) === 'REGISTERED'
        ? 'Paying for a plan is closed in India for now: ETicketsGo cannot issue a GST tax ' +
            'invoice yet. Nothing was charged. Contact ETicketsGo support.'
        : 'Paying for a plan is closed in India for now: ETicketsGo cannot issue an invoice ' +
            'yet. Nothing was charged. Contact ETicketsGo support.',
      HttpStatus.CONFLICT,
      { missing: problems },
    );
  }
}
