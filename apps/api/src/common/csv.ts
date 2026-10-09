/**
 * The single, injection-safe CSV serializer for the whole API. Every cell is quoted,
 * embedded quotes are doubled, rows are CRLF-delimited (RFC-4180), and any cell that
 * begins with a spreadsheet formula lead (`= + - @` / tab / CR) is prefixed with `'`
 * so it can't execute when the export is opened in Excel/Sheets. Use this everywhere
 * a CSV is produced rather than hand-rolling per-module escapers.
 */
export type CsvValue = string | number | null | undefined;

/** One CSV cell: quoted, quote-escaped, and guarded against formula injection. */
export function csvCell(value: CsvValue): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Build a CRLF-delimited CSV document from a header row + data rows. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

/**
 * The UTF-8 byte-order mark. Excel opens a CSV without one in the machine's legacy code page,
 * so an accented name, or one typed in Devanagari, arrives as mojibake. Written once,
 * at the very start of a download, never per chunk.
 */
export const CSV_BOM = String.fromCharCode(0xfeff);

/** One CRLF-terminated CSV line, for writers that stream a document a chunk at a time. */
export function csvLine(row: CsvValue[]): string {
  return `${row.map(csvCell).join(',')}\r\n`;
}
