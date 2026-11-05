import {
  LEGAL_ENTITIES,
  NEUTRAL_OPERATOR_SENTENCE,
  PLATFORM_OPERATOR,
  operatorSentence,
} from '@eticketsgo/shared-types';

/** One row of the read-only "Operating entities" view. */
export interface LegalEntityRow {
  country: string;
  legalName: string;
  shortName: string;
  /** The line pages and emails print for this company. */
  publicLine: string;
  /** Which transactions resolve to this company, in words. */
  usedFor: string;
  /** Company-record facts, or "Not recorded". Never a stand-in value. */
  registeredOffice: string;
  companyId: string;
  taxId: string;
}

const COUNTRY_NAME: Record<string, string> = { IN: 'India', US: 'United States' };
const USED_FOR: Record<string, string> = {
  IN: 'Transactions in India or in INR. Platform invoices to organizers registered in India.',
  US: 'Transactions in the United States or in USD. Platform invoices to organizers registered in the United States.',
};
const NOT_RECORDED = 'Not recorded';

/**
 * The entity map as the console shows it, read from the one registry in
 * `@eticketsgo/shared-types`. Read-only on purpose: a company name is changed in code, with a
 * review, never from a form.
 */
export function legalEntityRows(): LegalEntityRow[] {
  return Object.values(LEGAL_ENTITIES).map((e) => ({
    country: COUNTRY_NAME[e.country] ?? e.country,
    legalName: e.legalName,
    shortName: e.shortName,
    publicLine: operatorSentence(e),
    usedFor:
      (USED_FOR[e.country] ?? '') +
      (e === PLATFORM_OPERATOR ? ' Also the fallback for any other country or currency.' : ''),
    registeredOffice: e.registeredOffice ?? NOT_RECORDED,
    companyId: e.companyId ?? NOT_RECORDED,
    taxId: e.taxId ?? NOT_RECORDED,
  }));
}

/** What a public page says when the reader has selected no market. */
export const NEUTRAL_LINE = NEUTRAL_OPERATOR_SENTENCE;
