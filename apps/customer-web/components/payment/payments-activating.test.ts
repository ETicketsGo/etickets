import { describe, expect, it } from 'vitest';
import en from '@eticketsgo/i18n/messages/en/storefront.json';
import frCA from '@eticketsgo/i18n/messages/fr-CA/storefront.json';
import { paymentsActivatingCopy } from './payments-activating';

/*
  A US buyer of a USD ticket was told "Card, UPI and netbanking" will be available, and shown
  the India operator line. UPI and netbanking are Indian payment methods.
*/
describe('the payments-activating panel', () => {
  it('keeps the India wording, and the operator line, for an INR booking', () => {
    expect(paymentsActivatingCopy('INR')).toEqual({
      body: 'paymentsActivatingBody',
      showOperator: true,
    });
  });

  it.each(['USD', 'CAD', 'AUD', 'usd', null, undefined, ''])(
    'never names Indian payment methods or the India operator for %s',
    (currency) => {
      const copy = paymentsActivatingCopy(currency);
      expect(copy.showOperator).toBe(false);
      for (const messages of [en, frCA]) {
        const body = (messages as unknown as { checkout: Record<string, string> }).checkout[
          copy.body
        ];
        expect(body).toBeTruthy();
        expect(body).not.toMatch(/UPI|netbanking|virements bancaires|India|Inde|Hyderabad/i);
      }
    },
  );
});
