import { CSV_BOM, csvCell, csvLine, toCsv } from './csv';

/*
  The one CSV serializer every export goes through. A spreadsheet treats a cell that starts
  with = + - @ (or a tab or carriage return) as a formula, so a buyer who types
  `=HYPERLINK("http://evil","click")` as their name would otherwise run it on the organizer's
  machine the moment the attendee list is opened.
*/
describe('csv', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1'])(
    'neutralises a formula lead in %j by prefixing a quote',
    (value) => {
      expect(csvCell(value)).toBe(`"'${value}"`);
    },
  );

  it('leaves ordinary text alone apart from quoting it', () => {
    expect(csvCell('Ravi Kumar')).toBe('"Ravi Kumar"');
    expect(csvCell('a=b')).toBe('"a=b"');
  });

  it('doubles embedded quotes and keeps commas and newlines inside the cell', () => {
    expect(csvCell('say "hi", then\nleave')).toBe('"say ""hi"", then\nleave"');
  });

  it('writes null and undefined as empty cells and numbers as text', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(3)).toBe('"3"');
  });

  it('guards a formula that hides behind a quote once the quote is escaped', () => {
    // The guard runs on the raw value, so the quote doubling cannot move the lead character.
    expect(csvCell('=" "')).toBe(`"'="" """`);
  });

  it('csvLine ends every line with CRLF, and toCsv joins with CRLF', () => {
    expect(csvLine(['a', '=b'])).toBe(`"a","'=b"\r\n`);
    expect(toCsv(['h'], [['x'], ['y']])).toBe('"h"\r\n"x"\r\n"y"');
  });

  it('the BOM is the single UTF-8 byte-order mark', () => {
    expect(CSV_BOM).toHaveLength(1);
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
    expect(Buffer.from(CSV_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
