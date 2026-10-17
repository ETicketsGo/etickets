import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { INDIA_OPERATOR, type LegalEntity } from '@eticketsgo/shared-types';
import en from '@eticketsgo/i18n/messages/en/common.json';
import frCA from '@eticketsgo/i18n/messages/fr-CA/common.json';
import {
  INDIA_OPERATOR_SENTENCE,
  LEGAL_INFORMATION_HREF,
  legalBusinessFacts,
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
  it('is the owner line exactly, in English', () => {
    const t = createTranslator({
      locale: 'en',
      messages: { common: en },
      namespace: 'common.footer',
    });
    expect(t('rights', { year: 2026, entity: INDIA_OPERATOR.shortName })).toBe(
      '© 2026 ETicketsGo, DeepTrics Software Solutions Pvt Ltd | All rights reserved.',
    );
  });

  it('keeps the legal name untranslated in French', () => {
    const t = createTranslator({
      locale: 'fr-CA',
      messages: { common: frCA },
      namespace: 'common.footer',
    });
    expect(t('rights', { year: 2026, entity: INDIA_OPERATOR.shortName })).toBe(
      '© 2026 ETicketsGo, DeepTrics Software Solutions Pvt Ltd | Tous droits réservés.',
    );
  });

  it('is what BOTH footers render, from the registry rather than typed', () => {
    // The marketing footer used to carry its own hardcoded English line.
    for (const file of ['components/site-footer.tsx', 'components/marketing/footer.tsx']) {
      const src = read(file);
      expect(src, file).toMatch(/f\('rights', \{[^}]*entity: INDIA_OPERATOR\.shortName/);
      expect(src, file).not.toMatch(/All rights reserved/);
    }
  });
});

describe('the operator statement', () => {
  it('is the owner sentence verbatim', () => {
    expect(INDIA_OPERATOR_SENTENCE).toBe(
      'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.',
    );
  });

  it('is shown alone to an India reader, and beside the brand entity elsewhere', () => {
    expect(operatorSentences('IN')).toEqual([INDIA_OPERATOR_SENTENCE]);
    for (const c of ['US', 'CA', 'GLOBAL', undefined] as const) {
      expect(operatorSentences(c)).toEqual([
        'ETicketsGo is operated by DeepTrics LLC.',
        'In India, ETicketsGo is operated by DeepTrics Software Solutions Private Limited.',
      ]);
    }
  });

  it('never says who the contract is with, which is still open with counsel', () => {
    for (const c of ['IN', 'US', 'GLOBAL'] as const) {
      expect(operatorSentences(c).join(' ')).not.toMatch(/contract/i);
    }
  });

  it('is on the About page and on every legal document, resolved for its market', () => {
    expect(read('app/[locale]/about/page.tsx')).toContain('{INDIA_OPERATOR_SENTENCE}');
    for (const page of ['terms', 'privacy', 'refunds', 'sms', 'cookies']) {
      expect(read(`app/[locale]/${page}/page.tsx`), page).toContain(
        '<OperatorLine country={country} />',
      );
    }
    expect(read('app/[locale]/contact/page.tsx')).toContain('{INDIA_OPERATOR_SENTENCE}');
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
