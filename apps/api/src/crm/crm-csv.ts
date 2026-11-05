/**
 * Reading a spreadsheet export (RFC 4180 CSV) for the lead import.
 *
 * Small and strict on purpose: quoted fields, doubled quotes, CRLF or LF line ends and a UTF-8
 * byte-order mark (Excel writes one). A row-count cap is applied by the caller BEFORE any row is
 * validated, so an oversized file is refused rather than half-processed.
 */
export interface ParsedCsv {
  headers: string[];
  /** Data rows, each with its 1-based LINE number in the file as people see it. */
  rows: Array<{ line: number; cells: string[] }>;
}

export class CsvParseError extends Error {}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^﻿/, '');
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    // A completely empty line is skipped, not read as a row of blanks.
    if (!(cells.length === 1 && cells[0].trim() === '')) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endCell();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRecord();
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      line++;
      recordLine = line;
      continue;
    }
    cell += ch;
    i++;
  }
  if (quoted) throw new CsvParseError(`A quoted value starting on line ${recordLine} never ends.`);
  if (cell !== '' || cells.length > 0) endRecord();

  if (records.length === 0) throw new CsvParseError('The file has no header row.');
  const [head, ...rows] = records;
  return { headers: head.cells.map((h) => h.trim()), rows };
}

/** "Organization Name", "organization_name" and "organizationName" are the same column. */
export function headerKey(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Spreadsheet column headings we accept, mapped to lead fields. */
export const IMPORT_COLUMNS: Record<string, string> = {
  organizationname: 'organizationName',
  organization: 'organizationName',
  orgname: 'organizationName',
  company: 'organizationName',
  companyname: 'organizationName',
  name: 'organizationName',
  category: 'category',
  website: 'website',
  url: 'website',
  city: 'city',
  state: 'state',
  region: 'state',
  country: 'country',
  timezone: 'timezone',
  contactname: 'contactName',
  contact: 'contactName',
  contacttitle: 'contactTitle',
  title: 'contactTitle',
  email: 'email',
  businessemail: 'email',
  phone: 'phone',
  mobile: 'phone',
  sociallinks: 'socialLinks',
  linkedin: 'socialLinks',
  source: 'source',
  leadsource: 'source',
  priority: 'priority',
  notes: 'notes',
  tags: 'tags',
  assignee: 'assigneeEmail',
  assigneeemail: 'assigneeEmail',
  assignedto: 'assigneeEmail',
};
