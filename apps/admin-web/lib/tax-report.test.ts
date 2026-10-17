import { describe, expect, it } from 'vitest';
import { countWords, noTaxDocuments } from './tax-report';

describe('tax tab wording', () => {
  it('says one invoice and two invoices', () => {
    expect(countWords(1, 'invoice or receipt', 'invoices and receipts')).toBe(
      '1 invoice or receipt',
    );
    expect(countWords(0, 'credit note', 'credit notes')).toBe('0 credit notes');
    expect(countWords(2, 'credit note', 'credit notes')).toBe('2 credit notes');
  });

  it('knows a range with no documents', () => {
    expect(noTaxDocuments([])).toBe(true);
    expect(noTaxDocuments([{ invoices: 0, creditNotes: 0 }])).toBe(true);
    expect(noTaxDocuments([{ invoices: 1, creditNotes: 0 }])).toBe(false);
    expect(
      noTaxDocuments([
        { invoices: 0, creditNotes: 0 },
        { invoices: 0, creditNotes: 3 },
      ]),
    ).toBe(false);
    // An older API sends no counts: that is not "no documents".
    expect(noTaxDocuments([{}])).toBe(false);
  });
});
