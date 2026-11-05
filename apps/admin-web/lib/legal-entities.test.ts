import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_LINE, legalEntityRows } from './legal-entities';

describe('the read-only entity map', () => {
  it('shows both companies from the registry, with the line each prints', () => {
    const rows = legalEntityRows();
    expect(rows.map((r) => [r.country, r.legalName])).toEqual([
      ['United States', 'DeepTrics LLC'],
      ['India', 'DeepTrics Software Solutions Private Limited'],
    ]);
    expect(rows[1].publicLine).toBe(
      'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.',
    );
    expect(rows[0].usedFor).toMatch(/USD/);
    expect(rows[0].usedFor).toMatch(/fallback/);
    expect(rows[1].usedFor).toMatch(/INR/);
    expect(NEUTRAL_LINE).toContain('and in the United States by DeepTrics LLC');
  });

  it('invents no company-record fact', () => {
    for (const r of legalEntityRows()) {
      expect([r.registeredOffice, r.companyId, r.taxId]).toEqual([
        'Not recorded',
        'Not recorded',
        'Not recorded',
      ]);
    }
  });

  it('is on the payment configuration page, with no form to change it', () => {
    const page = readFileSync(
      join(__dirname, '..', 'app', 'admin', 'payment-config', 'page.tsx'),
      'utf8',
    );
    expect(page).toContain('<LegalEntitiesCard />');
    const card = page.slice(page.indexOf('function LegalEntitiesCard'));
    expect(card).not.toMatch(/<Input|<Select|useMutation|onClick/);
  });
});
