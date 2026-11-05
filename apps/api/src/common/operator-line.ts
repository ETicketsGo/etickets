import { t, type Locale } from '@eticketsgo/i18n';
import {
  LEGAL_ENTITIES,
  entityForCountry,
  entityForCurrency,
  type DocumentOperator,
  type LegalEntity,
} from '@eticketsgo/shared-types';

/**
 * "ETicketsGo is operated in India by ...", in the reader's language, for the API's own
 * surfaces: receipts, platform invoices and email footers.
 *
 * The English is the same sentence `operatorSentence` builds in `@eticketsgo/shared-types`
 * (a test holds them identical); the French lives beside it in the shared catalogue.
 *
 * `entity` null means nobody knows which market the reader is in, and the line names both
 * companies, each where it operates. That is true wherever it is read, which a guess is not.
 *
 * Takes a stored name and country rather than looking the entity up again, so a document
 * issued last year prints the name it was issued with, whatever this registry says today.
 */
export function operatorLine(
  locale: Locale,
  entity:
    | Pick<LegalEntity, 'legalName' | 'country'>
    | Pick<DocumentOperator, 'legalName' | 'country'>
    | null,
): string {
  if (entity && (entity.country === 'IN' || entity.country === 'US')) {
    return t(locale, `common.legalEntity.operated${entity.country}`, { entity: entity.legalName });
  }
  return t(locale, 'common.legalEntity.operatedNeutral', {
    india: LEGAL_ENTITIES.IN.legalName,
    us: LEGAL_ENTITIES.US.legalName,
  });
}

/**
 * The entity a notification is about, from what its payload already carries, or null.
 *
 * A payload is the only thing the email channel has at delivery time: the market a sender
 * knew is not stored on the queued row. Currency first, because it follows the payment
 * routing (INR to the Indian account, USD to the US one); then a country, when a producer set
 * one. Nothing else - and never the reader's network location - so a message with neither
 * gets the neutral line.
 */
export function entityForPayload(
  payload: Record<string, unknown> | null | undefined,
): LegalEntity | null {
  const p = payload ?? {};
  const text = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : null);
  return entityForCurrency(text('currency')) ?? entityForCountry(text('country'));
}
