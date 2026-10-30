import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  INDIA_OPERATOR,
  LEGAL_ENTITIES,
  NEUTRAL_OPERATOR_SENTENCE,
  publicLegalEntity,
  publicOperatorSentence,
  type LegalEntity,
} from '@eticketsgo/shared-types';
import en from '@eticketsgo/i18n/messages/en/common.json';
import frCA from '@eticketsgo/i18n/messages/fr-CA/common.json';
import storefrontEn from '@eticketsgo/i18n/messages/en/storefront.json';
import {
  INDIA_OPERATOR_SENTENCE,
  LEGAL_INFORMATION_HREF,
  US_OPERATOR_SENTENCE,
  checkoutOperatorCountry,
  contactOperator,
  footerOperator,
  operatingEntitiesForJsonLd,
  selectedMarketEntity,
  legalBusinessFacts,
  operatorMessage,
  operatorSentences,
} from './legal-entity';

/*
  The company disclosure a carrier checks for a DLT registration (STPL/MSG91). The owner gave
  the exact words; these tests hold the pages to them. Pages are .tsx and this suite has no JSX
  transform, so the wiring is checked by reading the source; the rendered pages are walked in
  a browser and by the e2e public-compliance suite.
*/

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('the footer line', () => {
  const footer = (locale: 'en' | 'fr-CA') =>
    createTranslator({
      locale,
      messages: { common: locale === 'en' ? en : frCA },
      namespace: 'common.footer',
    });

  it('is the owner copyright line exactly, naming no company', () => {
    expect(footer('en')('copyright', { year: 2026 })).toBe(
      '© 2026 ETicketsGo. All rights reserved.',
    );
    expect(footer('fr-CA')('copyright', { year: 2026 })).toBe(
      '© 2026 ETicketsGo. Tous droits réservés.',
    );
  });

  it('India: the owner operator line, with the legal name untranslated in French', () => {
    const m = footerOperator('IN')!;
    expect(footer('en')(m.key, m.values)).toBe(
      'Operated in India by DeepTrics Software Solutions Private Limited.',
    );
    expect(footer('fr-CA')(m.key, m.values)).toBe(
      'Exploité en Inde par DeepTrics Software Solutions Private Limited.',
    );
  });

  it('United States: the owner operator line', () => {
    const m = footerOperator('US')!;
    expect(footer('en')(m.key, m.values)).toBe('Operated in the United States by DeepTrics LLC.');
    expect(footer('fr-CA')(m.key, m.values)).toBe('Exploité aux États-Unis par DeepTrics LLC.');
  });

  it('an unknown market has no operator line at all, never both companies', () => {
    for (const m of [null, undefined, '', 'CA', 'GLOBAL']) expect(footerOperator(m)).toBeNull();
  });

  it('is what BOTH footers render, from the registry rather than typed', () => {
    // The marketing footer used to carry its own hardcoded English line.
    for (const file of ['components/site-footer.tsx', 'components/marketing/footer.tsx']) {
      const src = read(file);
      expect(src, file).toContain('<FooterLegalLines />');
      expect(src, file).not.toMatch(/All rights reserved|DeepTrics/);
    }
  });
});

describe('the operator statement', () => {
  it('is the owner sentence verbatim', () => {
    expect(INDIA_OPERATOR_SENTENCE).toBe(
      'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.',
    );
  });

  it('follows the selected market, and names both companies when there is none', () => {
    expect(operatorSentences('IN')).toEqual([INDIA_OPERATOR_SENTENCE]);
    expect(operatorSentences('US')).toEqual([US_OPERATOR_SENTENCE]);
    expect(US_OPERATOR_SENTENCE).toBe(
      'ETicketsGo is operated in the United States by DeepTrics LLC.',
    );
    for (const c of ['CA', 'GLOBAL', undefined, null]) {
      expect(operatorSentences(c)).toEqual([NEUTRAL_OPERATOR_SENTENCE]);
    }
  });

  it('says the same words in the storefront catalogue as in the registry', () => {
    const t = createTranslator({
      locale: 'en',
      messages: { common: en },
      namespace: 'common.legalEntity',
    });
    for (const market of ['IN', 'US', 'CA', null]) {
      const m = operatorMessage(publicLegalEntity(market));
      expect(t(m.key, m.values)).toBe(publicOperatorSentence(market));
    }
    const fr = createTranslator({
      locale: 'fr-CA',
      messages: { common: frCA },
      namespace: 'common.legalEntity',
    });
    const india = operatorMessage(LEGAL_ENTITIES.IN);
    expect(fr(india.key, india.values)).toBe(
      'ETicketsGo est exploité en Inde par DeepTrics Software Solutions Private Limited.',
    );
  });

  it('never says who the contract is with, which is still open with counsel', () => {
    for (const c of ['IN', 'US', 'GLOBAL']) {
      expect(operatorSentences(c).join(' ')).not.toMatch(/contract/i);
    }
  });

  it('is on the About page and on every legal document, resolved for its market', () => {
    expect(read('app/[locale]/about/page.tsx')).toContain('{INDIA_OPERATOR_SENTENCE}');
    for (const page of ['terms', 'privacy', 'refunds', 'sms', 'cookies']) {
      expect(read(`app/[locale]/${page}/page.tsx`), page).toContain(
        '<OperatorLine market={market} />',
      );
    }
    expect(read('app/[locale]/contact/page.tsx')).toContain('{operator.sentence}');
  });

  it('links to the section that exists', () => {
    expect(LEGAL_INFORMATION_HREF).toBe('/about#legal-information');
    expect(read('app/[locale]/about/page.tsx')).toContain('id="legal-information"');
  });
});

describe('legal and business information', () => {
  const EMPTY: LegalEntity = {
    legalName: 'DeepTrics Software Solutions Private Limited',
    shortName: 'DeepTrics Software Solutions Pvt Ltd',
    country: 'IN',
    registeredOffice: null,
    companyId: null,
    taxId: null,
  };

  it('renders no unverified field while the company record is empty', () => {
    const keys = legalBusinessFacts(EMPTY, null).map((f) => f.key);
    expect(keys).toEqual(['legalName', 'brand', 'sms']);
    expect(keys).not.toContain('registeredOffice');
    expect(keys).not.toContain('cin');
    expect(keys).not.toContain('gstin');
    expect(keys).not.toContain('supportEmail');
  });

  it('shows what the shipped registry holds today, and nothing more', () => {
    const facts = legalBusinessFacts();
    expect(facts.map((f) => f.key)).toEqual(['legalName', 'brand', 'supportEmail', 'sms']);
    expect(facts.find((f) => f.key === 'legalName')?.value).toBe(
      'DeepTrics Software Solutions Private Limited',
    );
    expect(facts.find((f) => f.key === 'supportEmail')).toMatchObject({
      value: 'support@eticketsgo.com',
      href: 'mailto:support@eticketsgo.com',
    });
    expect(facts.find((f) => f.key === 'sms')?.value).toContain('DPTRCS');
  });

  it('grows on its own once the owner supplies a field', () => {
    const filled: LegalEntity = {
      ...EMPTY,
      registeredOffice: '1 Owner Supplied Road, City 500001',
      companyId: 'OWNER-SUPPLIED-CIN',
      taxId: 'OWNER-SUPPLIED-GSTIN',
    };
    const facts = legalBusinessFacts(filled, 'help@eticketsgo.com');
    expect(facts.map((f) => f.key)).toEqual([
      'legalName',
      'brand',
      'registeredOffice',
      'cin',
      'gstin',
      'supportEmail',
      'sms',
    ]);
  });

  it('refuses a placeholder even if one is committed', () => {
    const keys = legalBusinessFacts(
      { ...EMPTY, companyId: 'TBD' },
      'support@eticketsgo.example',
    ).map((f) => f.key);
    expect(keys).not.toContain('cin');
    expect(keys).not.toContain('supportEmail');
  });
});

/*
  The checkout disclosure names the company the money goes to, from the booking currency -
  the same resolver as the receipt - and never the reader's market.
*/
describe('the checkout disclosure', () => {
  it('INR is the Indian company, USD is DeepTrics LLC, anything else the platform operator', () => {
    expect(checkoutOperatorCountry('INR')).toBe('IN');
    expect(checkoutOperatorCountry('USD')).toBe('US');
    expect(checkoutOperatorCountry('CAD')).toBe('US');
    expect(operatorMessage(publicLegalEntity(checkoutOperatorCountry('INR')))).toEqual({
      key: 'operatedIN',
      values: { entity: 'DeepTrics Software Solutions Private Limited' },
    });
  });

  it('is on both payment screens, read from the booking currency', () => {
    const src = read('app/[locale]/booking/[id]/payment/page.tsx');
    expect(src).toContain('market={checkoutOperatorCountry(booking.currency)}');
    expect(src).toContain('market={checkoutOperatorCountry(view.currency)}');
    expect(src).not.toMatch(/DeepTrics/);
  });

  it('the gateway-activation line names the company from the registry', () => {
    const t = createTranslator({
      locale: 'en',
      messages: { storefront: storefrontEn },
      namespace: 'storefront.checkout',
    });
    expect(t('paymentsActivatingOperator', { entity: INDIA_OPERATOR.legalName })).toContain(
      'operated in India by DeepTrics Software Solutions Private Limited',
    );
  });
});

/*
  QA 2026-10-28: /sms?country=IN said "DeepTrics LLC", /contact always named the Indian
  company, and the site JSON-LD said "DeepTrics LLC" on every page. Each now follows the
  market the reader chose, and names both companies when there is none.
*/
describe('pages follow the chosen market', () => {
  it('selectedMarketEntity names the chosen market and nobody when none is chosen', () => {
    expect(selectedMarketEntity('IN')?.legalName).toBe(
      'DeepTrics Software Solutions Private Limited',
    );
    expect(selectedMarketEntity('US')?.legalName).toBe('DeepTrics LLC');
    expect(selectedMarketEntity(null)).toBeNull();
    expect(selectedMarketEntity('CA')).toBeNull();
  });

  it('the SMS page reads the sender from the chosen market, not a fixed business name', () => {
    const src = read('app/[locale]/sms/page.tsx');
    expect(src).not.toContain('BUSINESS_DETAILS.legalName');
    expect(src).toContain('selectedMarketEntity(market)');
    expect(src).toContain('NEUTRAL_OPERATOR_SENTENCE');
  });

  it('the Contact page names the chosen market, and both companies with no choice', () => {
    expect(contactOperator('IN').heading).toBe(LEGAL_ENTITIES.IN.legalName);
    expect(contactOperator('IN').sentence).toBe(INDIA_OPERATOR_SENTENCE);
    expect(contactOperator('IN').description).toContain(LEGAL_ENTITIES.IN.legalName);
    expect(contactOperator('US').heading).toBe('DeepTrics LLC');
    expect(contactOperator('US').description).not.toContain(LEGAL_ENTITIES.IN.legalName);
    const neutral = contactOperator(null);
    expect(neutral.sentence).toBe(NEUTRAL_OPERATOR_SENTENCE);
    expect(neutral.heading).not.toMatch(/DeepTrics/);
    expect(neutral.description).toContain(LEGAL_ENTITIES.IN.legalName);
    expect(neutral.description).toContain(LEGAL_ENTITIES.US.legalName);
    for (const m of ['IN', 'US', null]) {
      // eslint-disable-next-line no-control-regex
      expect(JSON.stringify(contactOperator(m))).toMatch(/^[\x00-\x7F]*$/);
    }
    const src = read('app/[locale]/contact/page.tsx');
    expect(src).not.toContain('INDIA_OPERATOR');
    expect(src).toContain('resolveSelectedMarket(');
  });

  it('the site JSON-LD names no single company, and lists both in their countries', () => {
    expect(operatingEntitiesForJsonLd()).toEqual([
      { legalName: 'DeepTrics Software Solutions Private Limited', country: 'IN' },
      { legalName: 'DeepTrics LLC', country: 'US' },
    ]);
    const src = read('app/[locale]/layout.tsx');
    expect(src).not.toContain('PLATFORM_OPERATOR.legalName');
    expect(src).toContain('operators: operatingEntitiesForJsonLd()');
  });
});
