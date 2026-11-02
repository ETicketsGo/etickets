import { HttpStatus } from '@nestjs/common';
import { INDIA_OPERATOR, indiaState } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * Who issues an Indian platform invoice (ETGB series), as a GST tax invoice must say it.
 *
 * ── WHERE THE FACTS COME FROM ──────────────────────────────────────────────────────
 * The legal name is the India entity in shared-types `legal.ts` (INDIA_OPERATOR) - one
 * spelling for the footer, the DLT record and the invoice. The registration facts are
 * CONFIGURATION, never code, because only the owner can read them off the GST certificate:
 *
 *   BILLING_SELLER_GSTIN_IN    the 15-character GSTIN (format AND checksum are checked)
 *   BILLING_SELLER_SAC_IN      the 6-digit SAC (services accounting code, 99xxxx)
 *   BILLING_SELLER_ADDRESS_IN  the principal place of business, as registered
 *   PLATFORM_TAX_REGION        the registered state (already decides CGST + SGST vs IGST)
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────
 * In PRODUCTION an Indian checkout, and an Indian invoice, is refused while any of the four is
 * missing, the GSTIN does not pass its checksum, or the GSTIN's state code is not the
 * registered state: a "tax invoice" without a valid GSTIN is not one, and charging GST without
 * being able to issue one is worse than not selling. The boot check refuses the same thing
 * when IN is in BILLING_LIVE_MARKETS. Outside PRODUCTION what is set is printed, so QA can
 * see the layout with TEST values.
 *
 * The facts are frozen onto the invoice when it is issued (documentJson.seller); a later
 * change of configuration never rewrites an issued invoice.
 */
export interface IndiaSellerDetails {
  legalName: string;
  country: 'IN';
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

/** The configured seller facts, as they would be frozen on an invoice now. */
export function indiaSellerDetails(get: Get): IndiaSellerDetails {
  const state = indiaState(clean(get('PLATFORM_TAX_REGION')));
  return {
    legalName: INDIA_OPERATOR.legalName,
    country: 'IN',
    gstin: clean(get('BILLING_SELLER_GSTIN_IN'))?.toUpperCase() ?? null,
    sac: clean(get('BILLING_SELLER_SAC_IN')),
    address: clean(get('BILLING_SELLER_ADDRESS_IN')),
    state: state?.name ?? clean(get('PLATFORM_TAX_REGION')),
    stateCode: state?.code ?? null,
  };
}

/**
 * What stops these facts from going on a GST tax invoice, by variable NAME only (never a
 * value, so the list is safe to log and to show in a boot error). Empty: ready.
 */
export function indiaSellerProblems(get: Get): string[] {
  const d = indiaSellerDetails(get);
  const problems: string[] = [];
  if (!d.gstin) problems.push('BILLING_SELLER_GSTIN_IN is not set.');
  else if (!gstinValid(d.gstin)) {
    problems.push('BILLING_SELLER_GSTIN_IN is not a valid GSTIN (format or check character).');
  }
  if (!d.sac) problems.push('BILLING_SELLER_SAC_IN is not set.');
  else if (!sacValid(d.sac)) {
    problems.push('BILLING_SELLER_SAC_IN is not a 6-digit service code starting 99.');
  }
  if (!d.address) problems.push('BILLING_SELLER_ADDRESS_IN is not set.');
  else if (d.address.length < 10) {
    problems.push('BILLING_SELLER_ADDRESS_IN is too short to be a registered address.');
  }
  if (!clean(get('PLATFORM_TAX_REGION'))) problems.push('PLATFORM_TAX_REGION is not set.');
  else if (!d.stateCode) {
    problems.push('PLATFORM_TAX_REGION is not an Indian state or union territory.');
  }
  if (d.gstin && gstinValid(d.gstin) && d.stateCode && d.gstin.slice(0, 2) !== d.stateCode) {
    problems.push(
      'BILLING_SELLER_GSTIN_IN is registered in another state than PLATFORM_TAX_REGION ' +
        '(its first two digits are the state code).',
    );
  }
  return problems;
}

/**
 * Runtime guard: in PRODUCTION, refuses an Indian checkout or invoice while the seller facts
 * are incomplete or invalid. Other environments and other countries pass.
 */
export function assertIndiaSellerReady(get: Get, country: string | null | undefined): void {
  if ((country ?? '').toUpperCase() !== 'IN') return;
  if (get('APP_ENV') !== 'PRODUCTION') return;
  const problems = indiaSellerProblems(get);
  if (problems.length > 0) {
    throw new AppException(
      ErrorCodes.BILLING_NOT_ENABLED,
      'Paying for a plan is closed in India for now: ETicketsGo cannot issue a GST tax invoice ' +
        'yet. Nothing was charged. Contact ETicketsGo support.',
      HttpStatus.CONFLICT,
      { missing: problems },
    );
  }
}
