import {
  INDIA_OPERATOR,
  LEGAL_ENTITIES,
  operatorSentence,
  publicLegalEntity,
  publicOperatorSentence,
  resolveLegalEntity,
  type LegalEntity,
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
export const INDIA_OPERATOR_SENTENCE = operatorSentence(INDIA_OPERATOR);

/** The US counterpart, for the US supplements of the legal documents. */
export const US_OPERATOR_SENTENCE = operatorSentence(LEGAL_ENTITIES.US);

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
 * The operator line under a legal document, for the market the reader SELECTED.
 *
 * India: the India sentence. United States: the US sentence. Anything else, or no selection:
 * one sentence naming both companies, each where it operates. That fallback is deliberate.
 * It is true wherever it is read, it still shows the India company to the DLT reviewer who
 * opens the page with no market chosen, and it never rests on a guess from an IP address.
 */
export function operatorSentences(market?: string | null): string[] {
  return [publicOperatorSentence(market)];
}

/** A catalogue message: a key under `common.legalEntity` and its values. */
export interface OperatorMessage {
  key: 'operatedIN' | 'operatedUS' | 'operatedNeutral';
  values: Record<string, string>;
}

/**
 * The same operator sentence, as a catalogue message so the storefront can say it in French.
 * `entity` null is the neutral line. The English text equals `publicOperatorSentence`; a test
 * holds them identical.
 */
export function operatorMessage(
  entity: Pick<LegalEntity, 'legalName' | 'country'> | null,
): OperatorMessage {
  if (entity?.country === 'IN') return { key: 'operatedIN', values: { entity: entity.legalName } };
  if (entity?.country === 'US') return { key: 'operatedUS', values: { entity: entity.legalName } };
  return {
    key: 'operatedNeutral',
    values: { india: LEGAL_ENTITIES.IN.legalName, us: LEGAL_ENTITIES.US.legalName },
  };
}

/**
 * The footer's operator line for a selected market, as a `common.footer` message, or null.
 *
 * India: "Operated in India by <legal name>." United States: "Operated in the United States
 * by <legal name>." Anything else, or no market: null, and the footer shows only the neutral
 * copyright line. The footer never names both companies; the Legal & Policies pages do.
 */
export function footerOperator(
  market: string | null | undefined,
): { key: 'operatedIN' | 'operatedUS'; values: { entity: string } } | null {
  const entity = publicLegalEntity(market);
  if (entity?.country === 'IN') return { key: 'operatedIN', values: { entity: entity.legalName } };
  if (entity?.country === 'US') return { key: 'operatedUS', values: { entity: entity.legalName } };
  return null;
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

/**
 * The country of the company a checkout's money goes to, from the booking currency: the same
 * resolver, and the same answer, as the receipt that booking will get (INR the Indian
 * company, USD the US one, any other currency the platform operator). Never the reader's
 * market: somebody in the US buying an Indian ticket pays the Indian company.
 */
export function checkoutOperatorCountry(currency: string | null | undefined): string {
  return resolveLegalEntity({ currency }).entity.country;
}

/**
 * The company a public page names for the market the reader CHOSE (`resolveSelectedMarket`),
 * or null when they chose none or chose a market with no company. Null means "name both":
 * a page never falls back to one company, and never to a guess from an IP address.
 */
export function selectedMarketEntity(market: string | null | undefined): LegalEntity | null {
  return publicLegalEntity(market);
}

/** What the Contact page says about who the reader is writing to, for the chosen market. */
export interface ContactOperator {
  /** The company name, or a neutral heading when no market is chosen. */
  heading: string;
  /** The operator sentence: one company, or both. */
  sentence: string;
  /** The page's meta description. */
  description: string;
}

export function contactOperator(market: string | null | undefined): ContactOperator {
  const entity = selectedMarketEntity(market);
  const sentence = publicOperatorSentence(market);
  return {
    heading: entity ? entity.legalName : 'Who operates ETicketsGo',
    sentence,
    description: `Contact ETicketsGo for support and general enquiries. ${sentence}`,
  };
}

/**
 * The operating companies for the site-wide Organization JSON-LD. The layout is rendered once
 * for every visitor and cached, so it cannot know a chosen market: it names the brand and
 * lists each company as a sub-organization in its own country, which is true for every reader.
 */
export function operatingEntitiesForJsonLd(): { legalName: string; country: string }[] {
  return [LEGAL_ENTITIES.IN, LEGAL_ENTITIES.US].map((e) => ({
    legalName: e.legalName,
    country: e.country,
  }));
}
