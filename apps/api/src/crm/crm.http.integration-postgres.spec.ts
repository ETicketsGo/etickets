import { AdminPermission } from '@eticketsgo/shared-types';
import { CrmHarness, realDb } from './test-support/crm-http-harness';

/**
 * The acquisition CRM end to end: real HTTP, real guards, real Postgres.
 *
 * Covers lead CRUD, search/filter/pagination, duplicate detection, the controlled pipeline,
 * activation that only the platform's own data can prove, assignment with optimistic
 * concurrency, logged activities, follow-ups, CSV import and export, linking an existing
 * organization, and the reports. The agent-vs-the-rest-of-the-console boundary and the IDOR
 * checks live in crm-boundary.http.integration-postgres.spec.ts.
 */
const AGENT = [AdminPermission.CRM_AGENT];
const MANAGER = [AdminPermission.CRM_AGENT, AdminPermission.CRM_MANAGER];

describe('integration-real-postgres: organizer acquisition CRM', () => {
  const h = new CrmHarness();
  const maybe = realDb(h);
  const s = h.suffix;
  const lead = (name: string, extra: Record<string, unknown> = {}) => ({
    teamId: h.teams.in,
    organizationName: name,
    country: 'IN',
    source: 'REFERRAL',
    ...extra,
  });
  /** A phone number unique to this run, so dedupe never matches another spec's rows. */
  const phoneBase = String(Date.now() % 1e8).padStart(8, '0');
  const phone = (n: number) => `+91 9${phoneBase}${n}`;

  beforeAll(async () => {
    if (!(await h.start())) return;
    await h.user('super', ['ADMIN', 'SUPER_ADMIN']);
    await h.user('mgrIn', ['ADMIN'], MANAGER);
    await h.user('agentA', ['ADMIN'], AGENT);
    await h.user('agentB', ['ADMIN'], AGENT);
    await h.user('agentUs', ['ADMIN'], AGENT);
    await h.user('candidate', ['ADMIN'], AGENT);
    await h.user('noDuty', ['ADMIN'], [AdminPermission.BOOKING_READ]);
    await h.user('mgrCandidate', ['ADMIN'], MANAGER);
    await h.team('in', 'IN');
    await h.team('us', 'US');
    await h.member('in', 'mgrIn', 'MANAGER');
    await h.member('in', 'agentA', 'AGENT');
    await h.member('in', 'agentB', 'AGENT');
    await h.member('us', 'agentUs', 'AGENT');
  }, 180_000);

  afterAll(() => h.close(), 120_000);

  maybe('has the default India and USA teams, even after a reset emptied the tables', async () => {
    // The destructive seed truncates every table; the API's boot step puts the teams back.
    const teams = await h.db.crmTeam.findMany({ where: { key: { in: ['IN', 'US'] } } });
    expect(
      teams.map((t: { key: string; country: string }) => `${t.key}:${t.country}`).sort(),
    ).toEqual(['IN:IN', 'US:US']);
  });

  // ── Leads ───────────────────────────────────────────────────────────────────

  let leadA = '';
  maybe(
    'an agent adds a lead: it is theirs, starts IDENTIFIED, and is audited without PII',
    async () => {
      const r = await h.as('agentA').post('/admin/crm/leads', {
        ...lead(`Sunrise Events ${s} Pvt Ltd`),
        website: `sunrise-${s}.in`,
        email: `priya@sunrise-${s}.in`,
        phone: phone(1),
        contactName: 'Priya',
        city: 'Vijayawada',
        tags: ['music'],
      });
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({
        assignedToUserId: h.ids.agentA,
        stage: 'IDENTIFIED',
        country: 'IN',
        website: `https://sunrise-${s}.in`,
        version: 1,
      });
      leadA = r.json.id;
      const history = await h.db.crmLeadStageChange.findMany({ where: { leadId: leadA } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ fromStage: null, toStage: 'IDENTIFIED' });
      const audit = await h.db.auditLog.findFirst({
        where: { action: 'CRM_LEAD_CREATED', entityId: leadA },
      });
      expect(audit.actorUserId).toBe(h.ids.agentA);
      expect(JSON.stringify(audit.metadata)).not.toContain('priya');
      expect(JSON.stringify(audit.metadata)).not.toContain('Priya');
    },
  );

  maybe('refuses a lead in a team the agent is not on, or for the wrong country', async () => {
    const other = await h.as('agentA').post('/admin/crm/leads', {
      ...lead(`Elsewhere ${s}`),
      teamId: h.teams.us,
      country: 'US',
    });
    expect(other.status).toBe(403);
    const wrong = await h
      .as('agentA')
      .post('/admin/crm/leads', lead(`Wrong ${s}`, { country: 'US' }));
    expect(wrong.status).toBe(400);
  });

  maybe('an agent cannot hand a new lead to somebody else', async () => {
    const r = await h
      .as('agentA')
      .post('/admin/crm/leads', lead(`Handoff ${s}`, { assignedToUserId: h.ids.agentB }));
    expect(r.status).toBe(403);
  });

  maybe('rejects invalid fields with field-level errors', async () => {
    const r = await h.as('agentA').post('/admin/crm/leads', lead('', { email: 'nope' }));
    expect(r.status).toBe(400);
    expect(Object.keys(r.json.details.fields)).toEqual(
      expect.arrayContaining(['organizationName', 'email']),
    );
  });

  // ── Duplicates ──────────────────────────────────────────────────────────────

  maybe('flags a duplicate to another agent without revealing whose it is', async () => {
    const r = await h.as('agentB').post('/admin/crm/leads', lead(`SUNRISE EVENTS ${s}`));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('CRM_DUPLICATE_LEAD');
    const [m] = r.json.details.matches;
    expect(m).toEqual({ matchedOn: ['name'], visible: false });
    // And an agent cannot override it.
    const again = await h
      .as('agentB')
      .post('/admin/crm/leads', lead(`SUNRISE EVENTS ${s}`, { confirmDuplicate: true }));
    expect(again.status).toBe(409);
  });

  maybe('matches on the email domain and phone too, and shows a manager the match', async () => {
    const r = await h.as('mgrIn').post('/admin/crm/leads/duplicates', {
      email: `someone.else@sunrise-${s}.in`,
      phone: phone(1).replace('+91 ', '0'),
      country: 'IN',
    });
    expect(r.status).toBe(201);
    expect(r.json.matches[0]).toMatchObject({
      visible: true,
      id: leadA,
      matchedOn: expect.arrayContaining(['domain', 'phone']),
    });
    const byDomainOnly = await h.as('mgrIn').post('/admin/crm/leads/duplicates', {
      email: `info@sunrise-${s}.in`,
    });
    expect(byDomainOnly.json.matches).toEqual([
      expect.objectContaining({ id: leadA, matchedOn: ['domain'] }),
    ]);
  });

  maybe('lets a manager create a confirmed duplicate', async () => {
    const r = await h
      .as('mgrIn')
      .post('/admin/crm/leads', lead(`Sunrise Events ${s}`, { confirmDuplicate: true }));
    expect(r.status).toBe(201);
    expect(r.json.assignedToUserId).toBeNull();
    const audit = await h.db.auditLog.findFirst({
      where: { action: 'CRM_LEAD_CREATED', entityId: r.json.id },
    });
    expect(audit.metadata).toMatchObject({ duplicateOverride: true });
  });

  // ── Listing ─────────────────────────────────────────────────────────────────

  let leadB = '';
  maybe('lists server-side: an agent sees only their own, a manager the whole team', async () => {
    const b = await h
      .as('agentB')
      .post('/admin/crm/leads', lead(`Moonlight Shows ${s}`, { city: 'Guntur' }));
    expect(b.status).toBe(201);
    leadB = b.json.id;
    const mine = await h.as('agentA').get('/admin/crm/leads?pageSize=100');
    expect(mine.status).toBe(200);
    expect(mine.json.data.map((l: any) => l.id)).toEqual([leadA]);
    const all = await h.as('mgrIn').get('/admin/crm/leads?pageSize=100');
    expect(all.json.meta.total).toBe(3);
    const city = await h.as('mgrIn').get('/admin/crm/leads?city=guntur');
    expect(city.json.data.map((l: any) => l.id)).toEqual([leadB]);
    const q = await h.as('mgrIn').get(`/admin/crm/leads?q=moonlight`);
    expect(q.json.data.map((l: any) => l.id)).toEqual([leadB]);
    const unassigned = await h.as('mgrIn').get('/admin/crm/leads?assignee=none');
    expect(unassigned.json.meta.total).toBe(1);
    const tag = await h.as('mgrIn').get('/admin/crm/leads?tag=music');
    expect(tag.json.data.map((l: any) => l.id)).toEqual([leadA]);
  });

  maybe('paginates within a bounded page size', async () => {
    const p1 = await h.as('mgrIn').get('/admin/crm/leads?pageSize=2&page=1&sort=created');
    const p2 = await h.as('mgrIn').get('/admin/crm/leads?pageSize=2&page=2&sort=created');
    expect(p1.json.meta).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(p1.json.data).toHaveLength(2);
    expect(p2.json.data).toHaveLength(1);
    expect((await h.as('mgrIn').get('/admin/crm/leads?pageSize=500')).status).toBe(400);
  });

  // ── Editing and concurrency ─────────────────────────────────────────────────

  maybe('edits with the version read, and refuses a stale one', async () => {
    const ok = await h.as('agentA').patch(`/admin/crm/leads/${leadA}`, {
      version: 1,
      notes: 'Runs 12 shows a year',
      priority: 'HIGH',
    });
    expect(ok.status).toBe(200);
    expect(ok.json.lead).toMatchObject({ version: 2, priority: 'HIGH' });
    const stale = await h
      .as('agentA')
      .patch(`/admin/crm/leads/${leadA}`, { version: 1, notes: 'x' });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('CRM_STALE_VERSION');
    const audit = await h.db.auditLog.findFirst({
      where: { action: 'CRM_LEAD_UPDATED', entityId: leadA },
    });
    expect(audit.metadata).toEqual({ fields: ['notes', 'priority'] });
  });

  maybe(
    'assigning is a manager decision, to a team member, and two at once cannot both win',
    async () => {
      const byAgent = await h.as('agentB').post(`/admin/crm/leads/${leadB}/assign`, {
        version: 1,
        assignedToUserId: h.ids.agentB,
      });
      expect(byAgent.status).toBe(403);
      const outsider = await h.as('mgrIn').post(`/admin/crm/leads/${leadB}/assign`, {
        version: 1,
        assignedToUserId: h.ids.agentUs,
      });
      expect(outsider.status).toBe(400);
      const [x, y] = await Promise.all([
        h
          .as('mgrIn')
          .post(`/admin/crm/leads/${leadB}/assign`, { version: 1, assignedToUserId: h.ids.agentA }),
        h
          .as('mgrIn')
          .post(`/admin/crm/leads/${leadB}/assign`, { version: 1, assignedToUserId: h.ids.agentB }),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      // Put it back with agentB for the rest of the suite.
      const now = await h.db.crmLead.findUnique({ where: { id: leadB } });
      const back = await h.as('mgrIn').post(`/admin/crm/leads/${leadB}/assign`, {
        version: now.version,
        assignedToUserId: h.ids.agentB,
      });
      expect(back.status).toBe(201);
      const audits = await h.db.auditLog.count({
        where: { action: 'CRM_LEAD_ASSIGNED', entityId: leadB },
      });
      expect(audits).toBe(2);
    },
  );

  // ── Pipeline ────────────────────────────────────────────────────────────────

  const stage = async (
    who: string,
    id: string,
    to: string,
    extra: Record<string, unknown> = {},
  ) => {
    const v = (await h.db.crmLead.findUnique({ where: { id } })).version;
    return h.as(who).post(`/admin/crm/leads/${id}/stage`, { version: v, stage: to, ...extra });
  };

  maybe('moves only along the allowed transitions', async () => {
    const skip = await stage('agentA', leadA, 'DEMO_COMPLETED');
    expect(skip.status).toBe(400);
    expect(skip.json.code).toBe('CRM_TRANSITION_NOT_ALLOWED');
    expect((await stage('agentA', leadA, 'CONTACTED')).status).toBe(201);
    expect((await stage('agentA', leadA, 'RESPONDED_INTERESTED')).status).toBe(201);
  });

  maybe('needs a reason to lose a lead, and only a manager reopens it, with a note', async () => {
    expect((await stage('agentB', leadB, 'LOST')).status).toBe(400);
    expect((await stage('agentB', leadB, 'LOST', { lostReason: 'Uses a competitor' })).status).toBe(
      201,
    );
    expect((await stage('agentB', leadB, 'CONTACTED', { note: 'Came back' })).status).toBe(403);
    expect((await stage('mgrIn', leadB, 'CONTACTED')).status).toBe(400);
    const ok = await stage('mgrIn', leadB, 'CONTACTED', { note: 'Contract ended, try again' });
    expect(ok.status).toBe(201);
    expect(ok.json.lostReason).toBeNull();
    const history = await h.db.crmLeadStageChange.findMany({
      where: { leadId: leadB },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((x: any) => x.toStage)).toEqual(['IDENTIFIED', 'LOST', 'CONTACTED']);
  });

  let orgPending = '';
  maybe('refuses ACTIVATED until a linked organization has really been approved', async () => {
    expect((await stage('agentA', leadA, 'ONBOARDING')).status).toBe(201);
    const unlinked = await stage('agentA', leadA, 'ACTIVATED');
    expect(unlinked.status).toBe(409);
    expect(unlinked.json.code).toBe('CRM_ACTIVATION_NOT_PROVEN');

    orgPending = await h.organization('sunrise', 'PENDING');
    const v = (await h.db.crmLead.findUnique({ where: { id: leadA } })).version;
    const byAgent = await h.as('agentA').post(`/admin/crm/leads/${leadA}/organization`, {
      version: v,
      organizationId: orgPending,
    });
    expect(byAgent.status).toBe(403);
    const linked = await h.as('mgrIn').post(`/admin/crm/leads/${leadA}/organization`, {
      version: v,
      organizationId: orgPending,
    });
    expect(linked.status).toBe(201);
    // Linking changed nothing about the organization.
    const org = await h.db.organization.findUnique({ where: { id: orgPending } });
    expect(org.status).toBe('PENDING');

    const pending = await stage('agentA', leadA, 'ACTIVATED');
    expect(pending.status).toBe(409);
    expect(pending.json.message).toMatch(/PENDING/);

    // The organizer review flow approves it - outside the CRM.
    await h.db.organization.update({ where: { id: orgPending }, data: { status: 'APPROVED' } });
    expect((await stage('agentA', leadA, 'ACTIVATED')).status).toBe(201);
  });

  maybe('derives activation and the first published event from the platform data', async () => {
    const before = await h.as('agentA').get(`/admin/crm/leads/${leadA}`);
    expect(before.json.derived).toMatchObject({
      linked: true,
      activated: true,
      firstPublishedEventAt: null,
      publishedEventCount: 0,
    });
    const at = new Date('2026-09-01T10:00:00Z');
    await h.publishedEvent(orgPending, at);
    const after = await h.as('agentA').get(`/admin/crm/leads/${leadA}`);
    expect(after.json.derived).toMatchObject({
      firstPublishedEventAt: at.toISOString(),
      publishedEventCount: 1,
    });
    expect(after.json.stageHistory.map((x: any) => x.toStage)).toEqual([
      'IDENTIFIED',
      'CONTACTED',
      'RESPONDED_INTERESTED',
      'ONBOARDING',
      'ACTIVATED',
    ]);
  });

  maybe('links one organization to at most one lead', async () => {
    const v = (await h.db.crmLead.findUnique({ where: { id: leadB } })).version;
    const r = await h.as('mgrIn').post(`/admin/crm/leads/${leadB}/organization`, {
      version: v,
      organizationId: orgPending,
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('CRM_ORGANIZATION_ALREADY_LINKED');
  });

  maybe('finds existing organizations for a manager only, and never creates one', async () => {
    // Counted within this run's own rows: other spec files create organizations in parallel.
    const mine = { name: { contains: s } };
    const before = await h.db.organization.count({ where: mine });
    const r = await h.as('mgrIn').get(`/admin/crm/organizations?q=sunrise ${s}`);
    expect(r.status).toBe(200);
    expect(r.json[0]).toMatchObject({ id: orgPending, alreadyLinked: true });
    expect(r.json[0]).not.toHaveProperty('contactEmail');
    expect((await h.as('agentA').get(`/admin/crm/organizations?q=sunrise`)).status).toBe(403);
    expect(await h.db.organization.count({ where: mine })).toBe(before);
  });

  // ── Activities and follow-ups ───────────────────────────────────────────────

  let followUpId = '';
  maybe('logs outreach (never sends it) and schedules a follow-up with it', async () => {
    const due = new Date(Date.now() + 3 * 86_400_000);
    const r = await h.as('agentB').post(`/admin/crm/leads/${leadB}/activities`, {
      type: 'CALL',
      occurredAt: new Date().toISOString(),
      outcome: 'INTERESTED',
      notes: 'Wants a demo',
      followUp: { dueAt: due.toISOString(), title: 'Send demo slots' },
    });
    expect(r.status).toBe(201);
    expect(r.json.activity).toMatchObject({ type: 'CALL', responsible: { id: h.ids.agentB } });
    followUpId = r.json.followUp.id;
    const l = await h.db.crmLead.findUnique({ where: { id: leadB } });
    expect(l.nextFollowUpAt.toISOString()).toBe(due.toISOString());
    expect(l.lastActivityAt).not.toBeNull();
    // A logged email is a record, not a message: nothing reached the notification tables.
    const notes = await h.db.notification.count({
      where: { userId: { in: Object.values(h.ids) } },
    });
    expect(notes).toBe(0);
  });

  maybe(
    'refuses an activity dated in the future, or logged for somebody else by an agent',
    async () => {
      const future = await h.as('agentB').post(`/admin/crm/leads/${leadB}/activities`, {
        type: 'EMAIL',
        occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(future.status).toBe(400);
      const forOther = await h.as('agentB').post(`/admin/crm/leads/${leadB}/activities`, {
        type: 'EMAIL',
        occurredAt: new Date().toISOString(),
        responsibleUserId: h.ids.agentA,
      });
      expect(forOther.status).toBe(403);
    },
  );

  maybe('refuses a second open follow-up for the same lead, owner and day', async () => {
    const fu = await h.db.crmFollowUp.findUnique({ where: { id: followUpId } });
    const r = await h.as('agentB').post(`/admin/crm/leads/${leadB}/follow-ups`, {
      dueAt: new Date(fu.dueAt.getTime() + 60_000).toISOString(),
      title: 'Same day again',
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('CRM_DUPLICATE_FOLLOW_UP');
  });

  let overdueId = '';
  maybe('lists overdue and upcoming follow-ups, and completes with the version read', async () => {
    const past = await h.as('agentB').post(`/admin/crm/leads/${leadB}/follow-ups`, {
      dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      title: 'Call back',
    });
    expect(past.status).toBe(201);
    overdueId = past.json.id;
    const overdue = await h.as('agentB').get('/admin/crm/follow-ups?when=overdue&owner=me');
    expect(overdue.json.data.map((f: any) => f.id)).toEqual([overdueId]);
    const upcoming = await h.as('agentB').get('/admin/crm/follow-ups?when=upcoming');
    expect(upcoming.json.data.map((f: any) => f.id)).toEqual([followUpId]);
    const l = await h.db.crmLead.findUnique({ where: { id: leadB } });
    expect(l.nextFollowUpAt.toISOString()).toBe(past.json.dueAt);

    const stale = await h
      .as('agentB')
      .post(`/admin/crm/follow-ups/${overdueId}/complete`, { version: 9 });
    expect(stale.status).toBe(409);
    const done = await h.as('agentB').post(`/admin/crm/follow-ups/${overdueId}/complete`, {
      version: 1,
      note: 'Spoke to them',
    });
    expect(done.status).toBe(201);
    expect(done.json.status).toBe('DONE');
    const after = await h.db.crmLead.findUnique({ where: { id: leadB } });
    expect(after.nextFollowUpAt.toISOString()).not.toBe(past.json.dueAt);
    // Completing frees the day: the same follow-up can be scheduled again.
    const again = await h.as('agentB').post(`/admin/crm/leads/${leadB}/follow-ups`, {
      dueAt: past.json.dueAt,
      title: 'Call back',
    });
    expect(again.status).toBe(201);
  });

  maybe('reassigning a follow-up is a manager decision', async () => {
    const byAgent = await h.as('agentB').post(`/admin/crm/follow-ups/${followUpId}/reassign`, {
      version: 1,
      ownerUserId: h.ids.agentA,
    });
    expect(byAgent.status).toBe(403);
    const ok = await h.as('mgrIn').post(`/admin/crm/follow-ups/${followUpId}/reassign`, {
      version: 1,
      ownerUserId: h.ids.agentA,
    });
    expect(ok.status).toBe(201);
    expect(ok.json.owner.id).toBe(h.ids.agentA);
    // agentA now sees it in their own list, though the lead is agentB's.
    const mine = await h.as('agentA').get('/admin/crm/follow-ups?owner=me');
    expect(mine.json.data.map((f: any) => f.id)).toContain(followUpId);
  });

  maybe('lists logged activities in scope, by person', async () => {
    const b = await h.as('agentB').get('/admin/crm/activities?user=me');
    expect(b.json.meta.total).toBe(1);
    const a = await h.as('agentA').get('/admin/crm/activities');
    expect(a.json.meta.total).toBe(0);
    const m = await h.as('mgrIn').get('/admin/crm/activities?type=CALL');
    expect(m.json.meta.total).toBe(1);
  });

  // ── Import ──────────────────────────────────────────────────────────────────

  const csv = [
    'Organization Name,Website,City,Country,Email,Phone,Source,Priority,Tags,Assignee,Favourite colour',
    `Lotus Concerts ${s},lotus-${s}.in,Hyderabad,IN,hello@lotus-${s}.in,,Referral,high,music;comedy,agentA-${s}@test.invalid,blue`,
    `Broken Row ${s},,Hyderabad,IN,not-an-email,,,,,,`,
    `Wrong Country ${s},,Austin,US,,,,,,,`,
    `Sunrise Events ${s},,,IN,,,,,,,`,
    `"Lotus Concerts ${s}, LLC",,,IN,,,,,,,`,
    `"=HYPERLINK(""http://x"")" ${s},,,IN,,,,,,,`,
  ].join('\r\n');

  maybe('previews an import row by row and writes nothing', async () => {
    const before = await h.db.crmLead.count({ where: { teamId: h.teams.in } });
    const r = await h.as('mgrIn').post('/admin/crm/leads/import', { teamId: h.teams.in, csv });
    expect(r.status).toBe(201);
    expect(r.json.committed).toBe(false);
    expect(r.json.ignoredColumns).toEqual(['Favourite colour']);
    expect(r.json.summary).toMatchObject({
      rows: 6,
      ok: 2,
      duplicates: 2,
      errors: 2,
      willCreate: 2,
      created: 0,
    });
    const byLine = Object.fromEntries(r.json.rows.map((x: any) => [x.line, x]));
    expect(byLine[3].errors.join(' ')).toMatch(/email/);
    expect(byLine[4].errors.join(' ')).toMatch(/country/);
    expect(byLine[5]).toMatchObject({ status: 'duplicate', duplicateOf: 'existing' });
    expect(byLine[6]).toMatchObject({ status: 'duplicate', duplicateOf: 'file' });
    expect(await h.db.crmLead.count({ where: { teamId: h.teams.in } })).toBe(before);
  });

  maybe('commits only the valid rows, and an agent cannot import', async () => {
    expect(
      (await h.as('agentA').post('/admin/crm/leads/import', { teamId: h.teams.in, csv })).status,
    ).toBe(403);
    const r = await h.as('mgrIn').post('/admin/crm/leads/import', {
      teamId: h.teams.in,
      csv,
      commit: true,
    });
    expect(r.status).toBe(201);
    expect(r.json.summary.created).toBe(2);
    const lotus = await h.db.crmLead.findFirst({
      where: { teamId: h.teams.in, organizationName: `Lotus Concerts ${s}` },
    });
    expect(lotus).toMatchObject({
      assignedToUserId: h.ids.agentA,
      priority: 'HIGH',
      source: 'REFERRAL',
      tags: ['music', 'comedy'],
      stage: 'IDENTIFIED',
    });
    expect(await h.db.crmLeadStageChange.count({ where: { leadId: lotus.id } })).toBe(1);
  });

  maybe('refuses an import above the row cap as a whole', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => `Bulk ${s} ${i}`);
    const r = await h.as('mgrIn').post('/admin/crm/leads/import', {
      teamId: h.teams.in,
      csv: ['Organization', ...rows].join('\n'),
    });
    expect(r.status).toBe(400);
  });

  // ── Export ──────────────────────────────────────────────────────────────────

  maybe('exports the manager’s team only, safe for spreadsheets, and is audited', async () => {
    await h.as('agentUs').post('/admin/crm/leads', {
      teamId: h.teams.us,
      organizationName: `Austin Live ${s}`,
      country: 'US',
      source: 'EVENT',
    });
    expect((await h.as('agentA').get('/admin/crm/leads/export')).status).toBe(403);
    const r = await h.as('mgrIn').get('/admin/crm/leads/export');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.text).toContain(`Sunrise Events ${s}`);
    expect(r.text).not.toContain(`Austin Live ${s}`);
    // A cell that starts like a formula is neutralized.
    expect(r.text).toContain(`"'=HYPERLINK`);
    const audit = await h.db.auditLog.findFirst({
      where: { action: 'CRM_LEADS_EXPORTED', actorUserId: h.ids.mgrIn },
    });
    expect(audit.metadata.count).toBe(5);
  });

  // ── Archive ─────────────────────────────────────────────────────────────────

  maybe('archives (manager only) and hides archived leads from the default list', async () => {
    const lotus = await h.db.crmLead.findFirst({
      where: { teamId: h.teams.in, organizationName: { startsWith: '=HYPERLINK' } },
    });
    expect(
      (
        await h
          .as('agentA')
          .post(`/admin/crm/leads/${lotus.id}/archive`, { version: 1, archived: true })
      ).status,
    ).toBe(403);
    const r = await h.as('mgrIn').post(`/admin/crm/leads/${lotus.id}/archive`, {
      version: 1,
      archived: true,
    });
    expect(r.status).toBe(201);
    const list = await h.as('mgrIn').get('/admin/crm/leads?pageSize=100');
    expect(list.json.data.map((l: any) => l.id)).not.toContain(lotus.id);
    const archived = await h.as('mgrIn').get('/admin/crm/leads?archived=true');
    expect(archived.json.data.map((l: any) => l.id)).toEqual([lotus.id]);
  });

  // ── Reports ─────────────────────────────────────────────────────────────────

  maybe('gives an agent a dashboard of their own leads only', async () => {
    const r = await h.as('agentA').get('/admin/crm/reports/overview');
    expect(r.status).toBe(200);
    // agentA: leadA (activated) + the imported Lotus lead assigned to them.
    expect(r.json.totalProspects).toBe(2);
    expect(r.json.currentStage.ACTIVATED).toBe(1);
    expect(r.json.derived.activated).toEqual({ numerator: 1, denominator: 2 });
    expect(r.json.derived.activatedWithFirstEvent).toEqual({ numerator: 1, denominator: 1 });
    expect((await h.as('agentA').get('/admin/crm/reports/funnel')).status).toBe(403);
  });

  maybe('reports the team funnel with stated denominators and date filters', async () => {
    const f = await h.as('mgrIn').get('/admin/crm/reports/funnel');
    expect(f.status).toBe(200);
    // Not archived: leadA, the confirmed duplicate, leadB, Lotus.
    expect(f.json.cohort).toBe(4);
    const reached = Object.fromEntries(f.json.stages.map((x: any) => [x.stage, x.reached]));
    expect(reached).toMatchObject({
      IDENTIFIED: 4,
      CONTACTED: 2,
      RESPONDED_INTERESTED: 1,
      ONBOARDING: 1,
      ACTIVATED: 1,
    });
    expect(f.json.stages[0].ofCohort).toEqual({ numerator: 4, denominator: 4 });
    expect(f.json.derived.activated).toEqual({ numerator: 1, denominator: 4 });
    const step = f.json.conversionByStage.find((x: any) => x.to === 'CONTACTED');
    expect(step.rate).toEqual({ numerator: 2, denominator: 4 });

    const future = await h.as('mgrIn').get('/admin/crm/reports/funnel?from=2099-01-01');
    expect(future.json.cohort).toBe(0);
    expect(future.json.stages[0].ofCohort).toEqual({ numerator: 0, denominator: 0 });
  });

  maybe(
    'breaks down by country, source and person, and counts logged (not sent) outreach',
    async () => {
      const c = await h.as('mgrIn').get('/admin/crm/reports/by-country');
      expect(c.json.rows).toEqual([expect.objectContaining({ key: 'IN', total: 4 })]);
      const src = await h.as('mgrIn').get('/admin/crm/reports/by-source');
      const referral = src.json.rows.find((r: any) => r.key === 'REFERRAL');
      expect(referral.total).toBe(4);
      const e = await h.as('mgrIn').get('/admin/crm/reports/by-employee');
      expect(e.json.note).toMatch(/sends nothing/);
      const b = e.json.rows.find((r: any) => r.userId === h.ids.agentB);
      expect(b).toMatchObject({
        activitiesLogged: 1,
        activitiesByType: expect.objectContaining({ CALL: 1 }),
      });
      const a = await h.as('mgrIn').get('/admin/crm/reports/activity?bucket=month');
      expect(a.json.rows.reduce((t: number, r: any) => t + r.total, 0)).toBe(1);
      expect(JSON.stringify(a.json)).not.toMatch(/sent":/i);
    },
  );

  maybe('reports aging and onboarding / first-event conversion from real data', async () => {
    const ag = await h.as('mgrIn').get('/admin/crm/reports/aging');
    const ident = ag.json.rows.find((r: any) => r.stage === 'IDENTIFIED');
    expect(ident.count).toBe(2);
    const cv = await h.as('mgrIn').get('/admin/crm/reports/conversion');
    expect(cv.json.onboarding).toMatchObject({
      reached: 1,
      linked: { numerator: 1, denominator: 1 },
      approved: { numerator: 1, denominator: 1 },
    });
    expect(cv.json.firstEvent.withFirstPublishedEvent).toEqual({ numerator: 1, denominator: 1 });
    // Suspending the organizer un-activates the lead in every derived figure, whatever its stage.
    await h.db.organization.update({ where: { id: orgPending }, data: { status: 'SUSPENDED' } });
    const after = await h.as('mgrIn').get('/admin/crm/reports/conversion');
    expect(after.json.manualStage).toEqual({ activated: 1, activatedButNotApprovedNow: 1 });
    expect(after.json.firstEvent.approved.numerator).toBe(0);
    await h.db.organization.update({ where: { id: orgPending }, data: { status: 'APPROVED' } });
  });

  maybe('exports report CSVs to a manager', async () => {
    const r = await h.as('mgrIn').get('/admin/crm/reports/funnel?format=csv');
    expect(r.status).toBe(200);
    expect(r.text.split('\r\n')[0]).toBe('"Stage","Leads that reached it","Of leads in cohort"');
    expect((await h.as('mgrIn').get('/admin/crm/reports/conversion?format=csv')).status).toBe(400);
    expect((await h.as('mgrIn').get('/admin/crm/reports/nope')).status).toBe(404);
  });

  // ── Teams ───────────────────────────────────────────────────────────────────

  maybe('a manager adds an agent who already holds the duty, and nobody else', async () => {
    const cands = await h.as('mgrIn').get(`/admin/crm/teams/${h.teams.in}/candidates`);
    expect(cands.json.map((c: any) => c.id)).toContain(h.ids.candidate);
    expect(cands.json.map((c: any) => c.id)).not.toContain(h.ids.noDuty);
    const noDuty = await h
      .as('mgrIn')
      .put(`/admin/crm/teams/${h.teams.in}/members/${h.ids.noDuty}`, {
        role: 'AGENT',
      });
    expect(noDuty.status).toBe(400);
    const ok = await h
      .as('mgrIn')
      .put(`/admin/crm/teams/${h.teams.in}/members/${h.ids.candidate}`, {
        role: 'AGENT',
      });
    expect(ok.status).toBe(200);
    const audit = await h.db.auditLog.findFirst({
      where: { action: 'CRM_TEAM_MEMBER_ADDED', entityId: h.teams.in },
    });
    expect(audit.metadata).toMatchObject({ userId: h.ids.candidate, role: 'AGENT' });
  });

  maybe(
    'only a super admin appoints a manager, and nobody changes their own membership',
    async () => {
      const byMgr = await h
        .as('mgrIn')
        .put(`/admin/crm/teams/${h.teams.in}/members/${h.ids.mgrCandidate}`, { role: 'MANAGER' });
      expect(byMgr.status).toBe(403);
      const self = await h.as('mgrIn').del(`/admin/crm/teams/${h.teams.in}/members/${h.ids.mgrIn}`);
      expect(self.status).toBe(403);
      const otherTeam = await h
        .as('mgrIn')
        .put(`/admin/crm/teams/${h.teams.us}/members/${h.ids.candidate}`, { role: 'AGENT' });
      expect(otherTeam.status).toBe(403);
      const bySuper = await h
        .as('super')
        .put(`/admin/crm/teams/${h.teams.us}/members/${h.ids.mgrCandidate}`, { role: 'MANAGER' });
      expect(bySuper.status).toBe(200);
      const usLeads = await h.http('GET', '/admin/crm/leads', h.tokens.mgrCandidate);
      expect(usLeads.json.data.map((l: any) => l.organizationName)).toEqual([`Austin Live ${s}`]);
    },
  );

  maybe('taking an agent off the team removes their sight of its leads at once', async () => {
    const before = await h.as('agentA').get(`/admin/crm/leads/${leadA}`);
    expect(before.status).toBe(200);
    const r = await h.as('mgrIn').del(`/admin/crm/teams/${h.teams.in}/members/${h.ids.agentA}`);
    expect(r.status).toBe(200);
    expect(r.json.stillAssigned).toBe(2);
    expect((await h.as('agentA').get(`/admin/crm/leads/${leadA}`)).status).toBe(404);
    await h.member('in', 'agentA', 'AGENT');
  });

  maybe('shows a manager the members of their team, and an agent only their manager', async () => {
    const m = await h.as('mgrIn').get('/admin/crm/teams');
    const inTeam = m.json.find((t: any) => t.id === h.teams.in);
    expect(inTeam.manages).toBe(true);
    expect(inTeam.members.length).toBeGreaterThanOrEqual(4);
    const a = await h.as('agentA').get('/admin/crm/teams');
    const seen = a.json.find((t: any) => t.id === h.teams.in);
    expect(seen.members.map((x: any) => x.userId).sort()).toEqual(
      [h.ids.agentA, h.ids.mgrIn].sort(),
    );
    expect(seen.members[0]).not.toHaveProperty('email');
    const me = await h.as('agentA').get('/admin/crm/me');
    expect(me.json).toMatchObject({
      holdsManager: false,
      teams: [{ id: h.teams.in, manages: false }],
    });
  });
});
