import {
  LEGAL_ENTITIES,
  NEUTRAL_OPERATOR_SENTENCE,
  operatorSentence,
} from '@eticketsgo/shared-types';
import { entityForPayload, operatorLine } from './operator-line';

/*
  The API prints the operator line from the i18n catalogue, so French readers get French. The
  English must stay the owner's sentence, which shared-types builds; this holds them identical.
*/
describe('operatorLine', () => {
  it('is the shared-types sentence, word for word, in English', () => {
    expect(operatorLine('en', LEGAL_ENTITIES.IN)).toBe(operatorSentence(LEGAL_ENTITIES.IN));
    expect(operatorLine('en', LEGAL_ENTITIES.US)).toBe(operatorSentence(LEGAL_ENTITIES.US));
    expect(operatorLine('en', null)).toBe(NEUTRAL_OPERATOR_SENTENCE);
  });

  it('keeps the company names untranslated in French', () => {
    expect(operatorLine('fr-CA', LEGAL_ENTITIES.IN)).toBe(
      'ETicketsGo est exploité en Inde par DeepTrics Software Solutions Private Limited.',
    );
    expect(operatorLine('fr-CA', null)).toContain('DeepTrics LLC');
  });

  it('names both companies for an entity country it has no sentence for', () => {
    expect(operatorLine('en', { legalName: 'X', country: 'CA' })).toBe(NEUTRAL_OPERATOR_SENTENCE);
  });
});

describe('entityForPayload', () => {
  it('reads the currency first, then a country, and nothing else', () => {
    expect(entityForPayload({ currency: 'INR' })?.country).toBe('IN');
    expect(entityForPayload({ currency: 'USD', country: 'IN' })?.country).toBe('US');
    expect(entityForPayload({ country: 'India' })?.country).toBe('IN');
    expect(entityForPayload({ currency: 'CAD' })).toBeNull();
    expect(entityForPayload({})).toBeNull();
    expect(entityForPayload(null)).toBeNull();
    expect(entityForPayload({ currency: 5 })).toBeNull();
  });
});
