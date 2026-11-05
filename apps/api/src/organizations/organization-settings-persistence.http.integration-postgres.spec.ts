import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';

/**
 * integration-real-postgres, whole app over HTTP: every field of the organizer settings page
 * saves, reads back, and survives a save of something else (PROD report, 2026-11-04).
 *
 * What went wrong in production, and what each block below pins:
 *   - "Registered as" was saved but the form never loaded it back. The READ is pinned here
 *     (all sixteen legal fields come back from GET); the form is pinned by the e2e spec.
 *   - An uploaded picture writes an API PATH to `logoUrl`. The profile form sent it back on
 *     every save and the validator refused it, so after an upload no profile field could be
 *     saved at all.
 *   - A save sends only what changed, and the API must leave every other field alone.
 *
 * Every assertion that matters reads the TABLE afterwards, not the response. Fixtures carry a
 * unique suffix and are removed. Skips (never fabricates a pass) without a database.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const PASSWORD = 'Vermilion-Lantern-4821!';
// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const LEGAL_US = {
  legalName: 'QA-TEST Settings Persistence LLC',
  legalEntityType: 'Single-member LLC',
  taxRegistrationKind: 'EIN',
  taxRegistrationNumber: '12-3456789',
  registeredAddressLine1: '1141 E Fairview Ave',
  registeredAddressLine2: 'Suite 2',
  registeredCity: 'Meridian',
  registeredRegion: 'Idaho',
  registeredPostalCode: '83642',
  registeredCountry: 'United States',
  financeContactName: 'QA Finance',
  financeContactEmail: 'finance-qa@test.invalid',
  financeContactPhone: '+12085550100',
  grievanceOfficerName: 'QA Complaints',
  grievanceOfficerEmail: 'complaints-qa@test.invalid',
  grievanceOfficerPhone: '+12085550101',
};

const PROFILE = {
  description: 'QA-TEST organizer. Hosts test events only.',
  website: 'https://qa-settings.test.invalid',
  contactEmail: 'hello-qa@eticketsgo.com',
  contactPhone: '+12085550102',
  twitterUrl: 'https://x.com/qa_settings',
  instagramUrl: 'https://instagram.com/qa_settings',
  facebookUrl: 'https://facebook.com/qa_settings',
};

describe('integration-real-postgres: organizer settings persistence', () => {
  const url = process.env.DATABASE_URL;
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;
  const savedEnv = { ...process.env };

  const suffix = `settings-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const email = (who: string) => `${who.toLowerCase()}-${suffix}@test.invalid`;
  const ids: Record<string, string> = {};
  const orgIds: string[] = [];
  const tokens: Record<string, string> = {};

  async function http(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json: json?.data ?? json };
  }

  const row = (id: string) => db!.organization.findUnique({ where: { id } });

  async function makeUser(who: string) {
    const u = await db!.user.create({
      data: {
        email: email(who),
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        fullName: who,
        roles: ['CUSTOMER'],
      },
    });
    ids[who] = u.id;
  }

  async function makeOrg(label: string) {
    const org = await db!.organization.create({
      data: { name: `QA-TEST ${label} ${suffix}`, slug: `${label}-${suffix}`, status: 'APPROVED' },
    });
    orgIds.push(org.id);
    return org.id;
  }

  async function seat(orgId: string, userId: string, role: string) {
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId, role, status: 'ACTIVE' },
    });
  }

  async function login(who: string) {
    const r = await http('POST', '/auth/login', undefined, {
      email: email(who),
      password: PASSWORD,
    });
    expect(r.status).toBeLessThan(300);
    tokens[who] = r.json.accessToken;
  }

  let org = '';
  let otherOrg = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- DB unavailable');
      return;
    }
    process.env.APP_ENV = 'LOCAL';
    process.env.ORGANIZER_WEB_URL = 'https://organizer.example.test';
    process.env.ADMIN_WEB_URL = 'https://admin.example.test';
    process.env.THROTTLE_LIMIT = '100000';
    process.env.AUTH_THROTTLE_LIMIT = '100000';
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-settings-spec-0123456789abcdef';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-settings-spec-0123456789';
    process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-settings-spec-0123456789';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-settings-spec-0123456789';

    const { AppModule } = await import('../app.module');
    const { AllExceptionsFilter } = await import('../common/all-exceptions.filter');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    org = await makeOrg('main');
    otherOrg = await makeOrg('other');
    await makeUser('owner');
    await makeUser('manager');
    await makeUser('outsider');
    await seat(org, ids.owner, 'ORGANIZER_OWNER');
    await seat(org, ids.manager, 'ORGANIZER_MANAGER');
    await seat(otherOrg, ids.outsider, 'ORGANIZER_OWNER');
    for (const who of ['owner', 'manager', 'outsider']) await login(who);
  }, 120_000);

  afterAll(async () => {
    if (db && available) {
      const userIds = Object.values(ids);
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: { in: orgIds } }, { actorUserId: { in: userIds } }] },
      });
      await db.organizationImage.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    }
    if (app) await app.close();
    process.env = savedEnv;
  });

  const skip = () => !available;

  describe('legal and tax details', () => {
    it('stores all sixteen fields and the read that seeds the form returns every one', async () => {
      if (skip()) return;
      const w = await http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, LEGAL_US);
      expect(w.status).toBe(200);

      const stored = await row(org);
      for (const [k, v] of Object.entries(LEGAL_US)) expect([k, stored[k]]).toEqual([k, v]);

      const r = await http('GET', `/organizations/${org}/legal-identity`, tokens.owner);
      expect(r.status).toBe(200);
      for (const [k, v] of Object.entries(LEGAL_US)) expect([k, r.json[k]]).toEqual([k, v]);
      // The entity type is the one the form lost: the read must carry it.
      expect(r.json.legalEntityType).toBe('Single-member LLC');
      expect(r.json.missing).toEqual([]);
    });

    it('a save of one field leaves the other fifteen exactly as they were', async () => {
      if (skip()) return;
      const w = await http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, {
        financeContactPhone: '+12085550199',
      });
      expect(w.status).toBe(200);
      const stored = await row(org);
      expect(stored.financeContactPhone).toBe('+12085550199');
      for (const [k, v] of Object.entries(LEGAL_US)) {
        if (k !== 'financeContactPhone') expect([k, stored[k]]).toEqual([k, v]);
      }
    });

    it('clearing an optional field stores null and the completion list reports it', async () => {
      if (skip()) return;
      await http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, {
        registeredAddressLine2: '',
        financeContactEmail: '',
      });
      const stored = await row(org);
      expect(stored.registeredAddressLine2).toBeNull();
      expect(stored.financeContactEmail).toBeNull();
      expect(stored.legalName).toBe(LEGAL_US.legalName);

      const r = await http('GET', `/organizations/${org}/legal-identity`, tokens.owner);
      expect(r.json.missing).toContain('Finance contact email');
      const actions = await http('GET', `/organizations/${org}/actions`, tokens.owner);
      const finance = actions.json.actions.find(
        (a: { key: string }) => a.key === 'finance-contact',
      );
      expect(finance?.done).toBe(false);

      // And it goes away again once the field is back.
      await http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, {
        financeContactEmail: LEGAL_US.financeContactEmail,
      });
      const again = await http('GET', `/organizations/${org}/actions`, tokens.owner);
      const after = again.json.actions.find((a: { key: string }) => a.key === 'finance-contact');
      expect(after?.done ?? true).toBe(true);
    });

    it('refuses a postal code that cannot belong to the country, under that field, writing nothing', async () => {
      if (skip()) return;
      const w = await http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, {
        registeredPostalCode: '8364',
        registeredCity: 'Should Not Save',
      });
      expect(w.status).toBe(400);
      expect(JSON.stringify(w.json)).toContain('registeredPostalCode');
      expect(JSON.stringify(w.json)).toContain('ZIP code');
      const stored = await row(org);
      expect(stored.registeredPostalCode).toBe('83642');
      expect(stored.registeredCity).toBe('Meridian');
    });

    it('takes an Indian identity: GSTIN, state and PIN code, when the country changes with them', async () => {
      if (skip()) return;
      const india = {
        registeredCountry: 'India',
        legalEntityType: 'Private limited company',
        registeredRegion: 'Andhra Pradesh',
        registeredPostalCode: '520010',
        taxRegistrationKind: 'GSTIN',
        taxRegistrationNumber: '37AABCU9603R1ZM',
      };
      const bad = await http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, {
        ...india,
        registeredPostalCode: '83642',
      });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.json)).toContain('PIN code');

      const w = await http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, india);
      expect(w.status).toBe(200);
      const stored = await row(org);
      for (const [k, v] of Object.entries(india)) expect([k, stored[k]]).toEqual([k, v]);
      // What the country change did not touch is still there.
      expect(stored.legalName).toBe(LEGAL_US.legalName);
      expect(stored.grievanceOfficerEmail).toBe(LEGAL_US.grievanceOfficerEmail);
    });

    it('refuses a malformed email under its field', async () => {
      if (skip()) return;
      const w = await http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, {
        grievanceOfficerEmail: 'not-an-email',
      });
      expect(w.status).toBe(400);
      expect(JSON.stringify(w.json)).toContain('grievanceOfficerEmail');
      expect((await row(org)).grievanceOfficerEmail).toBe(LEGAL_US.grievanceOfficerEmail);
    });

    it('only the owner writes it; a manager reads it; another organization does neither', async () => {
      if (skip()) return;
      const asManager = await http(
        'PATCH',
        `/organizations/${org}/legal-identity`,
        tokens.manager,
        {
          legalName: 'Manager Overwrite',
        },
      );
      expect(asManager.status).toBe(403);
      expect(
        (await http('GET', `/organizations/${org}/legal-identity`, tokens.manager)).status,
      ).toBe(200);
      const asOutsider = await http(
        'PATCH',
        `/organizations/${org}/legal-identity`,
        tokens.outsider,
        {
          legalName: 'Outsider Overwrite',
        },
      );
      expect(asOutsider.status).toBe(403);
      expect(
        (await http('GET', `/organizations/${org}/legal-identity`, tokens.outsider)).status,
      ).toBe(403);
      expect((await row(org)).legalName).toBe(LEGAL_US.legalName);
      // And the outsider's own organization was not touched by any of this.
      expect((await row(otherOrg)).legalName).toBeNull();
    });
  });

  describe('country-aware contact and tax rules (owner, 2026-11-05)', () => {
    const legal = (body: Record<string, unknown>) =>
      http('PATCH', `/organizations/${org}/legal-identity`, tokens.owner, body);
    const fieldsOf = (r: { json: unknown }) =>
      Object.keys(((r.json as { details?: { fields?: object } })?.details?.fields ?? {}) as object);

    beforeAll(async () => {
      if (skip()) return;
      // A US organization again, whatever the tests above left it as.
      await db!.organization.update({
        where: { id: org },
        data: { ...LEGAL_US, additionalTaxRegistrations: undefined },
      });
    });

    it('US: refuses a malformed EIN and a personal SSN, saves a valid EIN', async () => {
      if (skip()) return;
      const bad = await legal({ taxRegistrationKind: 'EIN', taxRegistrationNumber: '12345689' });
      expect(bad.status).toBe(400);
      expect(fieldsOf(bad)).toEqual(['taxRegistrationNumber']);
      const ssn = await legal({ taxRegistrationNumber: '123-45-6789' });
      expect(ssn.status).toBe(400);
      expect(JSON.stringify(ssn.json)).toContain('SSN or ITIN');
      expect((await row(org)).taxRegistrationNumber).toBe('12-3456789');
      const ok = await legal({ taxRegistrationKind: 'EIN', taxRegistrationNumber: '98-7654321' });
      expect(ok.status).toBe(200);
      expect((await row(org)).taxRegistrationNumber).toBe('98-7654321');
    });

    it('US: several registrations persist, read back, and clear', async () => {
      if (skip()) return;
      const extra = [
        { kind: 'State sales tax ID', number: '123-4567890' },
        { kind: 'State sales tax ID', number: 'TX-32012345678' },
      ];
      const w = await legal({ additionalTaxRegistrations: extra });
      expect(w.status).toBe(200);
      expect((await row(org)).additionalTaxRegistrations).toEqual(extra);
      const r = await http('GET', `/organizations/${org}/legal-identity`, tokens.owner);
      expect(r.json.additionalTaxRegistrations).toEqual(extra);
      // The main registration, which documents print, is untouched.
      expect(r.json.taxRegistrationNumber).toBe('98-7654321');

      const dup = await legal({ additionalTaxRegistrations: [extra[0], extra[0]] });
      expect(dup.status).toBe(400);
      expect(fieldsOf(dup)).toEqual(['additionalTaxRegistrations.1']);
      const wrongCountry = await legal({
        additionalTaxRegistrations: [{ kind: 'GSTIN', number: '29AABCU9603R1ZM' }],
      });
      expect(wrongCountry.status).toBe(400);
      expect((await row(org)).additionalTaxRegistrations).toEqual(extra);

      expect((await legal({ additionalTaxRegistrations: [] })).status).toBe(200);
      expect((await row(org)).additionalTaxRegistrations).toBeNull();
    });

    it('"Not registered" carries no number', async () => {
      if (skip()) return;
      const withNumber = await legal({ taxRegistrationKind: 'Not registered' });
      expect(withNumber.status).toBe(400);
      const ok = await legal({ taxRegistrationKind: 'Not registered', taxRegistrationNumber: '' });
      expect(ok.status).toBe(200);
      const stored = await row(org);
      expect([stored.taxRegistrationKind, stored.taxRegistrationNumber]).toEqual([
        'Not registered',
        null,
      ]);
    });

    it('India: GSTIN and PAN formats; a PAN beside the GSTIN', async () => {
      if (skip()) return;
      const bad = await legal({
        registeredCountry: 'India',
        registeredRegion: 'Andhra Pradesh',
        registeredPostalCode: '520010',
        legalEntityType: 'Private limited company',
        taxRegistrationKind: 'GSTIN',
        taxRegistrationNumber: '37AABCU9603R1Z',
      });
      expect(bad.status).toBe(400);
      expect(fieldsOf(bad)).toEqual(['taxRegistrationNumber']);
      const ok = await legal({
        registeredCountry: 'India',
        registeredRegion: 'Andhra Pradesh',
        registeredPostalCode: '520010',
        legalEntityType: 'Private limited company',
        taxRegistrationKind: 'GSTIN',
        taxRegistrationNumber: '37AABCU9603R1ZM',
        additionalTaxRegistrations: [{ kind: 'PAN', number: 'AABCU9603R' }],
      });
      expect(ok.status).toBe(200);
      const stored = await row(org);
      expect(stored.taxRegistrationNumber).toBe('37AABCU9603R1ZM');
      expect(stored.additionalTaxRegistrations).toEqual([{ kind: 'PAN', number: 'AABCU9603R' }]);
      const badPan = await legal({
        additionalTaxRegistrations: [{ kind: 'PAN', number: 'ABC123' }],
      });
      expect(badPan.status).toBe(400);
    });

    it('phones: E.164 per country; letters and wrong lengths refused under the field', async () => {
      if (skip()) return;
      for (const bad of ['+91970446400', '+9197044640071', '+91 97044 64007', '+91970446CALL']) {
        const r = await legal({ financeContactPhone: bad });
        expect([bad, r.status]).toEqual([bad, 400]);
        expect(fieldsOf(r)).toEqual(['financeContactPhone']);
      }
      expect((await legal({ financeContactPhone: '+919704464007' })).status).toBe(200);
      expect((await row(org)).financeContactPhone).toBe('+919704464007');
      const pub = await http('PATCH', `/organizations/${org}`, tokens.owner, {
        contactPhone: '+9112',
      });
      expect(pub.status).toBe(400);
      expect(fieldsOf(pub)).toEqual(['contactPhone']);
    });

    it('names: five characters at least, international names welcome', async () => {
      if (skip()) return;
      const short = await legal({ financeContactName: '  Abc  ', grievanceOfficerName: 'A' });
      expect(short.status).toBe(400);
      expect(fieldsOf(short).sort()).toEqual(['financeContactName', 'grievanceOfficerName']);
      const ok = await legal({
        financeContactName: 'José Núñez',
        grievanceOfficerName: "Anne-Marie O'Brien",
      });
      expect(ok.status).toBe(200);
      expect((await row(org)).financeContactName).toBe('José Núñez');
    });

    it('emails: trimmed, international domains accepted, malformed refused', async () => {
      if (skip()) return;
      const ok = await legal({ financeContactEmail: '  Finance@Bücher.de ' });
      expect(ok.status).toBe(200);
      expect((await row(org)).financeContactEmail).toBe('finance@bücher.de');
      const bad = await legal({ grievanceOfficerEmail: 'a@b' });
      expect(bad.status).toBe(400);
      expect(fieldsOf(bad)).toEqual(['grievanceOfficerEmail']);
      const pub = await http('PATCH', `/organizations/${org}`, tokens.owner, {
        contactEmail: 'hello@xn--bcher-kva.de',
      });
      expect(pub.status).toBe(200);
    });

    it('values saved before these rules keep saving untouched beside another edit', async () => {
      if (skip()) return;
      // An older record: a spaced phone, a four-letter name, an 8-digit "EIN" with no kind.
      await db!.organization.update({
        where: { id: org },
        data: {
          registeredCountry: 'United States',
          registeredPostalCode: '83642',
          taxRegistrationKind: null,
          taxRegistrationNumber: '12345689',
          financeContactPhone: '+1 208 555 0100',
          financeContactName: 'Fins',
        },
      });
      // The admin card sends its whole draft, unchanged values included.
      const before = await row(org);
      const w = await legal({
        financeContactPhone: '+1 208 555 0100',
        financeContactName: 'Fins',
        taxRegistrationNumber: '12345689',
        registeredCity: 'Boise',
      });
      expect(w.status).toBe(200);
      const after = await row(org);
      expect(after.registeredCity).toBe('Boise');
      for (const k of [
        'financeContactPhone',
        'financeContactName',
        'taxRegistrationNumber',
      ] as const) {
        expect([k, after[k]]).toEqual([k, before[k]]);
      }
      // Changing one of them is judged.
      expect((await legal({ financeContactName: 'Fin' })).status).toBe(400);
    });
  });

  describe('public organizer profile and pictures', () => {
    it('stores all seven text fields and lists them back for the console', async () => {
      if (skip()) return;
      const w = await http('PATCH', `/organizations/${org}`, tokens.owner, PROFILE);
      expect(w.status).toBe(200);
      const stored = await row(org);
      for (const [k, v] of Object.entries(PROFILE)) expect([k, stored[k]]).toEqual([k, v]);

      const mine = await http('GET', '/organizations', tokens.owner);
      const listed = mine.json.find((o: { id: string }) => o.id === org);
      for (const [k, v] of Object.entries(PROFILE)) expect([k, listed[k]]).toEqual([k, v]);
    });

    it('uploads both pictures, and a later profile save neither fails nor drops them', async () => {
      if (skip()) return;
      for (const kind of ['logo', 'cover']) {
        const form = new FormData();
        form.append('file', new Blob([PNG], { type: 'image/png' }), `${kind}.png`);
        const up = await http('POST', `/organizations/${org}/${kind}`, tokens.owner, form);
        expect(up.status).toBe(201);
      }
      const withPictures = await row(org);
      expect(withPictures.logoUrl).toMatch(/^\/public\/organizers\/.+\/logo\?v=/);
      expect(withPictures.coverImageUrl).toMatch(/^\/public\/organizers\/.+\/cover\?v=/);

      // The old form sent the stored paths back. That used to be a 400 on every save.
      const echoed = await http('PATCH', `/organizations/${org}`, tokens.owner, {
        description: 'QA-TEST about, edited after an upload.',
        logoUrl: withPictures.logoUrl,
        coverImageUrl: withPictures.coverImageUrl,
      });
      expect(echoed.status).toBe(200);
      // The fixed form sends only what changed.
      const partial = await http('PATCH', `/organizations/${org}`, tokens.owner, {
        website: 'https://qa-settings-2.test.invalid',
      });
      expect(partial.status).toBe(200);

      const stored = await row(org);
      expect(stored.description).toBe('QA-TEST about, edited after an upload.');
      expect(stored.website).toBe('https://qa-settings-2.test.invalid');
      expect(stored.logoUrl).toBe(withPictures.logoUrl);
      expect(stored.coverImageUrl).toBe(withPictures.coverImageUrl);
      expect(stored.instagramUrl).toBe(PROFILE.instagramUrl);

      // The picture is actually served at the stored path.
      const img = await fetch(`${base}/api${stored.logoUrl}`);
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toContain('image/png');
    });

    it('clears an optional field and refuses a bad link under its field', async () => {
      if (skip()) return;
      const cleared = await http('PATCH', `/organizations/${org}`, tokens.owner, {
        twitterUrl: '',
      });
      expect(cleared.status).toBe(200);
      expect((await row(org)).twitterUrl).toBeNull();

      const bad = await http('PATCH', `/organizations/${org}`, tokens.owner, {
        facebookUrl: 'facebook.com/no-scheme',
      });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.json)).toContain('facebookUrl');
      expect((await row(org)).facebookUrl).toBe(PROFILE.facebookUrl);
    });

    it('the workspace colour saves alone, without touching the profile', async () => {
      if (skip()) return;
      const before = await row(org);
      const w = await http('PATCH', `/organizations/${org}`, tokens.owner, {
        consoleTheme: 'emerald',
      });
      expect(w.status).toBe(200);
      const after = await row(org);
      expect(after.consoleTheme).toBe('emerald');
      for (const k of [...Object.keys(PROFILE), 'logoUrl', 'coverImageUrl']) {
        expect([k, after[k]]).toEqual([k, before[k]]);
      }
    });

    it('another organization cannot edit this profile or replace its pictures', async () => {
      if (skip()) return;
      const w = await http('PATCH', `/organizations/${org}`, tokens.outsider, {
        website: 'https://x.test',
      });
      expect(w.status).toBe(403);
      const form = new FormData();
      form.append('file', new Blob([PNG], { type: 'image/png' }), 'logo.png');
      const up = await http('POST', `/organizations/${org}/logo`, tokens.outsider, form);
      expect(up.status).toBe(403);
      expect((await row(org)).website).toBe('https://qa-settings-2.test.invalid');
    });
  });
});
