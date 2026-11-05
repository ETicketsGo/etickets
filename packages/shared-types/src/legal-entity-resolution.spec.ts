import { describe, expect, it } from 'vitest';
import {
  LEGAL_ENTITIES,
  NEUTRAL_OPERATOR_SENTENCE,
  PLATFORM_OPERATOR,
  documentOperator,
  entityForCurrency,
  entityForMerchantOfRecord,
  operatorSentence,
  publicLegalEntity,
  publicOperatorSentence,
  resolveLegalEntity,
} from './legal';

const INDIA = 'DeepTrics Software Solutions Private Limited';
const US = 'DeepTrics LLC';

describe('resolveLegalEntity', () => {
  it('India by country and by INR', () => {
    expect(resolveLegalEntity({ transactionCountry: 'IN' })).toEqual({
      entity: LEGAL_ENTITIES.IN,
      basis: 'TRANSACTION_COUNTRY',
    });
    expect(resolveLegalEntity({ transactionCountry: 'India' }).entity.legalName).toBe(INDIA);
    expect(resolveLegalEntity({ currency: 'INR' })).toEqual({
      entity: LEGAL_ENTITIES.IN,
      basis: 'CURRENCY',
    });
    expect(resolveLegalEntity({ currency: 'inr' }).entity.legalName).toBe(INDIA);
  });

  it('United States by country and by USD', () => {
    expect(resolveLegalEntity({ transactionCountry: 'US' }).entity.legalName).toBe(US);
    expect(resolveLegalEntity({ transactionCountry: 'United States' }).entity.legalName).toBe(US);
    expect(resolveLegalEntity({ currency: 'USD' })).toEqual({
      entity: LEGAL_ENTITIES.US,
      basis: 'CURRENCY',
    });
  });

  it('an unknown market falls back to the platform operator, and says so', () => {
    expect(resolveLegalEntity({})).toEqual({ entity: PLATFORM_OPERATOR, basis: 'DEFAULT' });
    expect(resolveLegalEntity({ market: 'CA' })).toEqual({
      entity: PLATFORM_OPERATOR,
      basis: 'DEFAULT',
    });
    expect(resolveLegalEntity({ market: 'Narnia', currency: 'CAD' }).basis).toBe('DEFAULT');
  });

  it('merchant of record beats the market a reader is browsing', () => {
    expect(resolveLegalEntity({ merchantOfRecord: 'IN', market: 'US' })).toEqual({
      entity: LEGAL_ENTITIES.IN,
      basis: 'MERCHANT_OF_RECORD',
    });
    expect(resolveLegalEntity({ merchantOfRecord: 'STRIPE', market: 'IN' }).entity.legalName).toBe(
      US,
    );
    expect(
      resolveLegalEntity({ merchantOfRecord: 'RAZORPAY_BILLING', market: 'US' }).entity.legalName,
    ).toBe(INDIA);
  });

  it('merchant of record beats country and currency too', () => {
    expect(
      resolveLegalEntity({ merchantOfRecord: 'US', transactionCountry: 'IN', currency: 'INR' })
        .entity.legalName,
    ).toBe(US);
  });

  it('the transaction beats the market: a US reader buying an Indian ticket deals with India', () => {
    expect(resolveLegalEntity({ currency: 'INR', market: 'US' }).entity.legalName).toBe(INDIA);
    expect(resolveLegalEntity({ transactionCountry: 'IN', market: 'US' }).basis).toBe(
      'TRANSACTION_COUNTRY',
    );
  });

  it('a country with no company is skipped, not allowed to stop the search', () => {
    expect(resolveLegalEntity({ transactionCountry: 'CA', currency: 'INR' }).basis).toBe(
      'CURRENCY',
    );
  });

  it('the test double and unknown providers are not evidence', () => {
    expect(entityForMerchantOfRecord('MOCK')).toBeNull();
    expect(entityForMerchantOfRecord('')).toBeNull();
    expect(entityForMerchantOfRecord(null)).toBeNull();
  });

  it('only INR and USD name an entity by currency', () => {
    expect(entityForCurrency('CAD')).toBeNull();
    expect(entityForCurrency('GBP')).toBeNull();
    expect(entityForCurrency(undefined)).toBeNull();
  });
});

describe('public operator lines', () => {
  it('are the owner sentences, verbatim', () => {
    expect(operatorSentence(LEGAL_ENTITIES.IN)).toBe(
      'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.',
    );
    expect(operatorSentence(LEGAL_ENTITIES.US)).toBe(
      'ETicketsGo is operated in the United States by DeepTrics LLC.',
    );
  });

  it('follow the selected market, and name both companies when there is none', () => {
    expect(publicOperatorSentence('IN')).toBe(operatorSentence(LEGAL_ENTITIES.IN));
    expect(publicOperatorSentence('US')).toBe(operatorSentence(LEGAL_ENTITIES.US));
    for (const unknown of [null, undefined, '', 'CA', 'GB', 'Narnia']) {
      expect(publicLegalEntity(unknown)).toBeNull();
      expect(publicOperatorSentence(unknown)).toBe(NEUTRAL_OPERATOR_SENTENCE);
    }
    expect(NEUTRAL_OPERATOR_SENTENCE).toBe(
      'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited and in the United States by DeepTrics LLC.',
    );
  });

  it('are plain ASCII', () => {
    for (const s of [
      NEUTRAL_OPERATOR_SENTENCE,
      operatorSentence(LEGAL_ENTITIES.IN),
      operatorSentence(LEGAL_ENTITIES.US),
    ]) {
      expect(s).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('documentOperator', () => {
  it('records the name, the entity country and why, and nothing invented', () => {
    expect(documentOperator({ currency: 'INR' })).toEqual({
      legalName: INDIA,
      country: 'IN',
      basis: 'CURRENCY',
    });
    expect(Object.keys(documentOperator({ currency: 'USD' })).sort()).toEqual([
      'basis',
      'country',
      'legalName',
    ]);
  });
});
