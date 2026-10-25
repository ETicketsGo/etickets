import {
  INDIA_OPERATOR,
  PLATFORM_OPERATOR,
  type LegalEntity,
  type PolicyJurisdiction,
} from '@eticketsgo/shared-types';
import { BUSINESS_DETAILS, publishedDetail } from '@eticketsgo/web-kit';

/**
 * What the public pages say about the company behind ETicketsGo.
 *
 * -- WHY THIS IS ONE FILE ---------------------------------------------------------------
 * A carrier reviewing a DLT registration (STPL/MSG91) checks that the website names the
 * same company as the Principal Entity record, character for character, and that the brand
 * and the company are visibly connected. The footer, the About page, the Contact page and
 * every legal document all make that statement, so they all read it from here, and here
 * reads the names from the entity registry in `@eticketsgo/shared-types`. Nothing on a page
 * types the company name itself.
 *
 * -- WHAT IS NOT CLAIMED -----------------------------------------------------------------
 * "Operated in India by" is the owner's own statement. Which entity is the CONTRACTING party
 * for a given sale is a separate question that is still open with counsel
 * (docs/compliance/LEGAL-REVIEW-QUESTIONS.md), so no sentence here says "your contract is
 * with". Registered office, CIN and GSTIN appear only once the owner has supplied them from
 * the company's records; until then the row is absent, never a stand-in.
 */

/** The owner's sentence, verbatim. The About page and the India documents show it. */
export const INDIA_OPERATOR_SENTENCE = `ETicketsGo is operated in India by ${INDIA_OPERATOR.legalName}.`;

/**
 * The sender header registered on DLT under the Principal Entity above, and the signature
 * every India template ends with. Source: docs/notifications/INDIA-DLT-TEMPLATES.md (header
 * APPROVED) and `DOCUMENTED_APPROVED_SENDER_HEADERS` in the API's dlt-sms-templates.ts. Every
 * template there ends "- DeepTrics".
 */
export const INDIA_SMS_SENDER_HEADER = 'DPTRCS';
export const INDIA_SMS_SIGNATURE = 'DeepTrics';

/** Where the "Legal and business information" section lives, for links to it. */
export const LEGAL_INFORMATION_HREF = '/about#legal-information';

/**
 * The operator line under a legal document.
 *
 * India readers get the India sentence. Everyone else keeps the line they had - the brand's
 * own entity - plus the India sentence, because the reviewer who checks the India entity may
 * well open the page without an India market selected, and the statement is true wherever
 * it is read.
 */
export function operatorSentences(country?: PolicyJurisdiction | null): string[] {
  if (country === 'IN') return [INDIA_OPERATOR_SENTENCE];
  return [
    `ETicketsGo is operated by ${PLATFORM_OPERATOR.legalName}.`,
    `In India, ETicketsGo is operated by ${INDIA_OPERATOR.legalName}.`,
  ];
}

/** One row of the legal and business information section. */
export interface BusinessFact {
  key: 'legalName' | 'brand' | 'registeredOffice' | 'cin' | 'gstin' | 'supportEmail' | 'sms';
  label: string;
  value: string;
  /** A mailto for the support address, so it can be used and not only read. */
  href?: string;
}

/**
 * The rows the section shows, in order, leaving out every fact that is not published.
 *
 * Every optional value goes through `publishedDetail`, so a placeholder-shaped value (an
 * `.example` address, "TBD") is refused at render even if somebody commits one.
 */
export function legalBusinessFacts(
  entity: LegalEntity = INDIA_OPERATOR,
  supportEmail: string | null = BUSINESS_DETAILS.supportEmail,
): BusinessFact[] {
  const facts: BusinessFact[] = [
    { key: 'legalName', label: 'Company', value: entity.legalName },
    { key: 'brand', label: 'Brand', value: INDIA_OPERATOR_SENTENCE },
  ];
  const office = publishedDetail(entity.registeredOffice);
  if (office) facts.push({ key: 'registeredOffice', label: 'Registered office', value: office });
  const cin = publishedDetail(entity.companyId);
  if (cin) facts.push({ key: 'cin', label: 'CIN', value: cin });
  const gstin = publishedDetail(entity.taxId);
  if (gstin) facts.push({ key: 'gstin', label: 'GSTIN', value: gstin });
  const email = publishedDetail(supportEmail);
  if (email) {
    facts.push({
      key: 'supportEmail',
      label: 'Support email',
      value: email,
      href: `mailto:${email}`,
    });
  }
  facts.push({
    key: 'sms',
    label: 'Text messages in India',
    value: `Sent under the sender ID ${INDIA_SMS_SENDER_HEADER}, registered to ${INDIA_OPERATOR.legalName}. Each message ends with the name ${INDIA_SMS_SIGNATURE}.`,
  });
  return facts;
}
