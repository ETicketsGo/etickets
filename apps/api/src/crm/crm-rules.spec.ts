import {
  CRM_PIPELINE,
  CRM_STAGES,
  CRM_TRANSITIONS,
  canTransition,
  isReopen,
} from '@eticketsgo/shared-types';
import {
  crmActivitySchema,
  crmCreateLeadSchema,
  crmLeadListQuerySchema,
  crmUpdateLeadSchema,
} from '@eticketsgo/validation';
import { CsvParseError, headerKey, IMPORT_COLUMNS, parseCsv } from './crm-csv';
import {
  emailDomain,
  leadKeys,
  nameKey,
  phoneKey,
  sharedKeys,
  websiteDomain,
} from './crm-normalize';
import { dayIn, followUpOpenKey } from './crm-activities.service';

/**
 * The pure rules of the acquisition CRM: duplicate keys, the pipeline map, the CSV reader and
 * the payload schemas. Everything that touches the database is in the *.integration-postgres
 * specs beside this one.
 */
describe('duplicate keys', () => {
  it('treats one company written several ways as one name', () => {
    const k = nameKey('Sunrise Events Pvt. Ltd.');
    expect(k).toBe('sunrise events');
    expect(nameKey('  SUNRISE   events  ')).toBe(k);
    expect(nameKey('The Sunrise Events Private Limited')).toBe(k);
    expect(nameKey('Sunrise Events, LLC')).toBe(k);
    expect(nameKey('Café Música')).toBe('cafe musica');
    expect(nameKey('Rock & Roll Co')).toBe('rock and roll');
  });

  it('does not invent a name from nothing', () => {
    expect(nameKey('')).toBeNull();
    expect(nameKey('Ltd.')).toBeNull();
    expect(nameKey(null)).toBeNull();
  });

  it('reads a website down to its domain', () => {
    expect(websiteDomain('https://www.Example.com/about?x=1')).toBe('example.com');
    expect(websiteDomain('example.com')).toBe('example.com');
    expect(websiteDomain('http://shows.example.co.in:8080/')).toBe('shows.example.co.in');
    expect(websiteDomain('not a site')).toBeNull();
  });

  it('takes the domain from a business email but never from a free mailbox', () => {
    expect(emailDomain('Priya@Sunrise-Events.in')).toBe('sunrise-events.in');
    expect(emailDomain('someone@gmail.com')).toBeNull();
    expect(emailDomain('someone@yahoo.co.in')).toBeNull();
    // So two unrelated gmail prospects are not duplicates of each other.
    const a = leadKeys({ organizationName: 'A', email: 'a@gmail.com' });
    const b = leadKeys({ organizationName: 'B', email: 'b@gmail.com' });
    expect(sharedKeys(a, b)).toEqual([]);
  });

  it('reads an Indian or US number the same whichever way it is typed', () => {
    const k = '919876543210';
    expect(phoneKey('+91 98765 43210', 'IN')).toBe(k);
    expect(phoneKey('098765 43210', 'IN')).toBe(k);
    expect(phoneKey('9876543210', 'IN')).toBe(k);
    expect(phoneKey('0091-98765-43210', 'IN')).toBe(k);
    expect(phoneKey('(415) 555-0134', 'US')).toBe('14155550134');
    expect(phoneKey('+1 415 555 0134', 'US')).toBe('14155550134');
    expect(phoneKey('123', 'US')).toBeNull();
  });

  it('names every key two leads share', () => {
    const a = leadKeys({
      organizationName: 'Sunrise Events',
      website: 'sunrise-events.in',
      email: 'hello@sunrise-events.in',
      phone: '+91 98765 43210',
      country: 'IN',
    });
    const b = leadKeys({
      organizationName: 'SUNRISE EVENTS PVT LTD',
      email: 'Hello@Sunrise-Events.in',
      phone: '9876543210',
      country: 'IN',
    });
    expect(sharedKeys(a, b).sort()).toEqual(['domain', 'email', 'name', 'phone']);
  });
});

describe('the pipeline', () => {
  it('reaches LOST from every other stage', () => {
    for (const s of CRM_STAGES) if (s !== 'LOST') expect(canTransition(s, 'LOST')).toBe(true);
  });

  it('only reopens a lost lead to the start of the pipeline', () => {
    expect(CRM_TRANSITIONS.LOST).toEqual(['IDENTIFIED', 'CONTACTED']);
    expect(canTransition('LOST', 'NEGOTIATION')).toBe(false);
    expect(isReopen('LOST', 'IDENTIFIED')).toBe(true);
    expect(isReopen('CONTACTED', 'LOST')).toBe(false);
  });

  it('reaches ACTIVATED only from ONBOARDING, and leaves it only to LOST', () => {
    const into = CRM_STAGES.filter((s) => CRM_TRANSITIONS[s].includes('ACTIVATED'));
    expect(into).toEqual(['ONBOARDING']);
    expect(CRM_TRANSITIONS.ACTIVATED).toEqual(['LOST']);
  });

  it('never moves to the stage it is in, and every target is a real stage', () => {
    for (const s of CRM_STAGES) {
      expect(CRM_TRANSITIONS[s]).not.toContain(s);
      for (const t of CRM_TRANSITIONS[s]) expect(CRM_STAGES).toContain(t);
    }
  });

  it('keeps every pipeline stage reachable from IDENTIFIED', () => {
    const seen = new Set(['IDENTIFIED']);
    const queue = ['IDENTIFIED'];
    while (queue.length) {
      const s = queue.shift() as (typeof CRM_STAGES)[number];
      for (const t of CRM_TRANSITIONS[s]) if (!seen.has(t)) seen.add(t) && queue.push(t);
    }
    for (const s of CRM_PIPELINE) expect(seen.has(s)).toBe(true);
  });
});

describe('the CSV reader', () => {
  it('reads quotes, doubled quotes, commas and line breaks inside a value', () => {
    const csv =
      '﻿Organization Name,Notes\r\n"Acme, Inc","Said ""call me""\nnext week"\r\nBeta,\r\n';
    const p = parseCsv(csv);
    expect(p.headers).toEqual(['Organization Name', 'Notes']);
    expect(p.rows).toEqual([
      { line: 2, cells: ['Acme, Inc', 'Said "call me"\nnext week'] },
      { line: 4, cells: ['Beta', ''] },
    ]);
  });

  it('skips empty lines and refuses an unterminated quote', () => {
    expect(parseCsv('a\n\n\nb\n').rows.map((r) => r.cells[0])).toEqual(['b']);
    expect(() => parseCsv('a\n"open')).toThrow(CsvParseError);
    expect(() => parseCsv('')).toThrow(CsvParseError);
  });

  it('maps the column headings people actually use', () => {
    expect(IMPORT_COLUMNS[headerKey('Organization Name')]).toBe('organizationName');
    expect(IMPORT_COLUMNS[headerKey('organization_name')]).toBe('organizationName');
    expect(IMPORT_COLUMNS[headerKey('Business Email')]).toBe('email');
    expect(IMPORT_COLUMNS[headerKey('Assigned To')]).toBe('assigneeEmail');
    expect(IMPORT_COLUMNS[headerKey('Favourite colour')]).toBeUndefined();
  });
});

describe('follow-up day keys', () => {
  it('uses the prospect’s own calendar day', () => {
    // 20:00 UTC on the 23rd is already the 24th in India.
    const at = new Date('2026-10-23T20:00:00Z');
    expect(dayIn(at, 'Asia/Kolkata')).toBe('2026-10-24');
    expect(dayIn(at, 'America/New_York')).toBe('2026-10-23');
    expect(followUpOpenKey('lead1', 'u1', at, 'Asia/Kolkata')).toBe('lead1:u1:2026-10-24');
  });
});

describe('payload schemas', () => {
  const base = {
    teamId: 't1',
    organizationName: 'Sunrise Events',
    country: 'IN',
    source: 'REFERRAL',
  };

  it('accepts a quick entry with only the essentials', () => {
    expect(crmCreateLeadSchema.safeParse(base).success).toBe(true);
  });

  it('adds https to a bare website and clears an empty field', () => {
    const r = crmCreateLeadSchema.parse({ ...base, website: 'sunrise.in', email: '' });
    expect(r.website).toBe('https://sunrise.in');
    expect(r.email).toBeNull();
  });

  it('refuses a country the desk does not work, a made-up source and a bad email', () => {
    expect(crmCreateLeadSchema.safeParse({ ...base, country: 'FR' }).success).toBe(false);
    expect(crmCreateLeadSchema.safeParse({ ...base, source: 'MAGIC' }).success).toBe(false);
    expect(crmCreateLeadSchema.safeParse({ ...base, email: 'nope' }).success).toBe(false);
    expect(crmCreateLeadSchema.safeParse({ ...base, phone: '12' }).success).toBe(false);
    expect(crmCreateLeadSchema.safeParse({ ...base, timezone: 'Mars/Base' }).success).toBe(false);
  });

  it('needs the version on every edit, and cannot move a lead to another country', () => {
    expect(crmUpdateLeadSchema.safeParse({ notes: 'x' }).success).toBe(false);
    const r = crmUpdateLeadSchema.parse({ version: 3, country: 'US', notes: 'x' });
    expect(r).not.toHaveProperty('country');
  });

  it('bounds list pages', () => {
    expect(crmLeadListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(crmLeadListQuerySchema.parse({}).pageSize).toBe(25);
  });

  it('knows the five kinds of logged outreach and nothing else', () => {
    const at = new Date().toISOString();
    for (const type of ['EMAIL', 'CALL', 'LINKEDIN', 'MEETING', 'VISIT']) {
      expect(crmActivitySchema.safeParse({ type, occurredAt: at }).success).toBe(true);
    }
    expect(crmActivitySchema.safeParse({ type: 'SMS', occurredAt: at }).success).toBe(false);
  });
});
