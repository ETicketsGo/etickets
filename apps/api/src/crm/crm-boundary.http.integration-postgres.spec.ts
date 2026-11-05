import { AdminPermission } from '@eticketsgo/shared-types';
import { CrmHarness, realDb } from './test-support/crm-http-harness';

/**
 * What an acquisition agent can NOT do, over real HTTP and Postgres.
 *
 * ── WHY THIS IS ITS OWN SPEC ───────────────────────────────────────────────────────
 * The CRM desk will be staffed by interns contacting prospects. Their account is a back-office
 * account (ADMIN role) holding exactly one duty, CRM_AGENT, and the claim that matters is about
 * everything ELSE such an account can reach: no booking, no customer, no payment or payout, no
 * platform setting, no staff or role management, no organizer's private data. Each of those is
 * called here with an agent-only token and must be refused.
 *
 * And inside the CRM: an agent reaching another agent's lead, or another country's, by guessing
 * its id is answered exactly as for a lead that does not exist (IDOR).
 */
describe('integration-real-postgres: an acquisition agent stays inside the CRM', () => {
  const h = new CrmHarness();
  const maybe = realDb(h);
  const s = h.suffix;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    if (!(await h.start())) return;
    await h.user('agent', ['ADMIN'], [AdminPermission.CRM_AGENT]);
    await h.user('peer', ['ADMIN'], [AdminPermission.CRM_AGENT]);
    await h.user('usAgent', ['ADMIN'], [AdminPermission.CRM_AGENT]);
    await h.user('mgrIn', ['ADMIN'], [AdminPermission.CRM_AGENT, AdminPermission.CRM_MANAGER]);
    await h.user('support', ['ADMIN'], [AdminPermission.BOOKING_READ]);
    await h.user('customer', ['CUSTOMER']);
    await h.team('in', 'IN');
    await h.team('us', 'US');
    await h.member('in', 'agent', 'AGENT');
    await h.member('in', 'peer', 'AGENT');
    await h.member('in', 'mgrIn', 'MANAGER');
    await h.member('us', 'usAgent', 'AGENT');
    ids.org = await h.organization('boundary', 'APPROVED');

    const make = async (who: string, team: string, country: string, name: string) => {
      const r = await h.as(who).post('/admin/crm/leads', {
        teamId: h.teams[team],
        country,
        organizationName: `${name} ${s}`,
        source: 'RESEARCH',
        email: `hello@${name.toLowerCase()}-${s}.org`,
      });
      expect(r.status).toBe(201);
      return r.json.id as string;
    };
    ids.mine = await make('agent', 'in', 'IN', 'Mine');
    ids.peers = await make('peer', 'in', 'IN', 'Peers');
    ids.us = await make('usAgent', 'us', 'US', 'Texan');
    const fu = await h.as('peer').post(`/admin/crm/leads/${ids.peers}/follow-ups`, {
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      title: 'Peer follow-up',
    });
    ids.peerFollowUp = fu.json.id;
  }, 180_000);

  afterAll(() => h.close(), 120_000);

  // ── Who gets in at all ──────────────────────────────────────────────────────

  maybe('refuses a request with no session (401)', async () => {
    expect((await h.http('GET', '/admin/crm/leads')).status).toBe(401);
    expect((await h.http('GET', '/admin/crm/reports/overview')).status).toBe(401);
    expect((await h.http('POST', '/admin/crm/leads', undefined, {})).status).toBe(401);
  });

  maybe('refuses a customer and a back-office account without the CRM duty (403)', async () => {
    for (const who of ['customer', 'support']) {
      expect((await h.as(who).get('/admin/crm/leads')).status).toBe(403);
      expect((await h.as(who).get('/admin/crm/me')).status).toBe(403);
      expect((await h.as(who).get(`/admin/crm/leads/${ids.mine}`)).status).toBe(403);
      expect((await h.as(who).post('/admin/crm/leads', {})).status).toBe(403);
    }
  });

  maybe('refuses the manager routes to an agent (403)', async () => {
    const a = h.as('agent');
    expect((await a.get('/admin/crm/leads/export')).status).toBe(403);
    expect((await a.post('/admin/crm/leads/import', { teamId: h.teams.in, csv: 'a' })).status).toBe(
      403,
    );
    expect((await a.get('/admin/crm/reports/funnel')).status).toBe(403);
    expect((await a.get('/admin/crm/reports/by-employee?format=csv')).status).toBe(403);
    expect((await a.get('/admin/crm/organizations?q=boundary')).status).toBe(403);
    expect(
      (await a.post(`/admin/crm/leads/${ids.mine}/assign`, { version: 1, assignedToUserId: null }))
        .status,
    ).toBe(403);
    expect(
      (await a.put(`/admin/crm/teams/${h.teams.in}/members/${h.ids.peer}`, { role: 'AGENT' }))
        .status,
    ).toBe(403);
    expect(
      (await a.post('/admin/crm/teams', { key: `X${s}`.slice(0, 20), name: 'X', country: 'IN' }))
        .status,
    ).toBe(403);
  });

  // ── The rest of the console ─────────────────────────────────────────────────

  const SENSITIVE_READS = [
    // bookings, payments, customers
    '/admin/bookings',
    '/admin/payments',
    '/admin/dashboard',
    '/admin/grouped/bookings',
    '/users',
    '/users/directory-summary',
    '/admin/support',
    '/admin/refunds',
    '/admin/disputes',
    // money
    '/admin/payouts',
    '/admin/payouts/accounts',
    '/admin/payout-settings',
    '/admin/settlements',
    '/admin/reports/daily-revenue',
    '/admin/reports/organizer-revenue',
    '/admin/payments/finance/discrepancies',
    '/admin/compensations',
    // payment settings and platform configuration
    '/admin/payments/config',
    '/admin/payments/reconciliation',
    '/admin/fee-rules',
    '/admin/tax-rules',
    '/admin/cinema-pricing-policies',
    '/admin/ops/queues',
    '/admin/ops/flags',
    // staff, roles and the record of who did what
    '/admin/staff',
    '/admin/staff/catalogue',
    '/admin/audit',
    // organizers: the review queue and an organizer's own console data
    '/admin/organizers',
    '/admin/events',
  ];

  maybe('is refused every sensitive read on the admin surface (403)', async () => {
    const leaked: string[] = [];
    for (const path of SENSITIVE_READS) {
      const r = await h.as('agent').get(path);
      if (r.status !== 403) leaked.push(`${path} -> ${r.status}`);
    }
    expect(leaked).toEqual([]);
  });

  maybe('cannot open an organizer’s own console data, payout account or members', async () => {
    for (const path of [
      `/organizations/${ids.org}`,
      `/organizations/${ids.org}/members`,
      `/organizations/${ids.org}/legal-identity`,
      `/admin/organizers/${ids.org}/legal-identity`,
      `/admin/payouts/accounts/${ids.org}/history`,
    ]) {
      const r = await h.as('agent').get(path);
      expect([403, 404]).toContain(r.status);
      expect(r.status).not.toBe(200);
    }
  });

  maybe('cannot change any duties, its own or anybody else’s (no self-escalation)', async () => {
    const self = await h.as('agent').put(`/admin/staff/${h.ids.agent}/permissions`, {
      permissions: [
        AdminPermission.CRM_AGENT,
        AdminPermission.CRM_MANAGER,
        AdminPermission.FINANCE_READ,
      ],
    });
    expect(self.status).toBe(403);
    const other = await h.as('agent').put(`/admin/staff/${h.ids.peer}/permissions`, {
      permissions: [AdminPermission.CRM_MANAGER],
    });
    expect(other.status).toBe(403);
    const grants = await h.db.adminGrant.findMany({ where: { userId: h.ids.agent } });
    expect(grants.map((g: { permission: string }) => g.permission)).toEqual([
      AdminPermission.CRM_AGENT,
    ]);
    // Nor join a team as its manager.
    const join = await h.as('agent').put(`/admin/crm/teams/${h.teams.in}/members/${h.ids.agent}`, {
      role: 'MANAGER',
    });
    expect(join.status).toBe(403);
  });

  maybe('cannot suspend accounts or change payment configuration', async () => {
    expect(
      (await h.as('agent').post(`/admin/users/${h.ids.customer}/suspend`, { reason: 'x' })).status,
    ).toBe(403);
    expect((await h.as('agent').put('/admin/payments/config', {})).status).not.toBeLessThan(400);
  });

  // ── Inside the CRM: other agents' and other countries' leads (IDOR) ─────────

  maybe(
    'answers another agent’s or another country’s lead as if it did not exist (404)',
    async () => {
      const a = h.as('agent');
      for (const id of [ids.peers, ids.us, 'no-such-lead']) {
        const r = await a.get(`/admin/crm/leads/${id}`);
        expect(r.status).toBe(404);
        expect(r.text).not.toContain(s); // nothing about the lead leaks in the refusal
      }
      for (const id of [ids.peers, ids.us]) {
        expect((await a.patch(`/admin/crm/leads/${id}`, { version: 1, notes: 'x' })).status).toBe(
          404,
        );
        expect(
          (await a.post(`/admin/crm/leads/${id}/stage`, { version: 1, stage: 'CONTACTED' })).status,
        ).toBe(404);
        expect(
          (
            await a.post(`/admin/crm/leads/${id}/activities`, {
              type: 'CALL',
              occurredAt: new Date().toISOString(),
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await a.post(`/admin/crm/leads/${id}/follow-ups`, {
              dueAt: new Date().toISOString(),
              title: 'Hijack',
            })
          ).status,
        ).toBe(404);
      }
      expect(
        (await a.post(`/admin/crm/follow-ups/${ids.peerFollowUp}/complete`, { version: 1 })).status,
      ).toBe(404);
      // And nothing changed.
      const peers = await h.db.crmLead.findUnique({ where: { id: ids.peers } });
      expect(peers).toMatchObject({ version: 1, stage: 'IDENTIFIED', notes: null });
      expect(await h.db.crmActivity.count({ where: { leadId: { in: [ids.peers, ids.us] } } })).toBe(
        0,
      );
    },
  );

  maybe('never lists, counts or reports leads outside the agent’s scope', async () => {
    const list = await h.as('agent').get('/admin/crm/leads?pageSize=100');
    expect(list.json.data.map((l: { id: string }) => l.id)).toEqual([ids.mine]);
    const filtered = await h.as('agent').get(`/admin/crm/leads?assignee=${h.ids.peer}`);
    expect(filtered.json.meta.total).toBe(0);
    const other = await h.as('agent').get(`/admin/crm/leads?teamId=${h.teams.us}&country=US`);
    expect(other.json.meta.total).toBe(0);
    const fus = await h.as('agent').get('/admin/crm/follow-ups?when=all');
    expect(fus.json.data.map((f: { id: string }) => f.id)).not.toContain(ids.peerFollowUp);
    const acts = await h.as('agent').get(`/admin/crm/activities?leadId=${ids.peers}`);
    expect(acts.json.meta.total).toBe(0);
    const kpi = await h.as('agent').get('/admin/crm/reports/overview');
    expect(kpi.json.totalProspects).toBe(1);
  });

  maybe('keeps a manager to their own country too', async () => {
    const m = h.as('mgrIn');
    expect((await m.get(`/admin/crm/leads/${ids.peers}`)).status).toBe(200);
    expect((await m.get(`/admin/crm/leads/${ids.us}`)).status).toBe(404);
    const exp = await m.get('/admin/crm/leads/export');
    expect(exp.text).toContain(`Peers ${s}`);
    expect(exp.text).not.toContain(`Texan ${s}`);
    const byCountry = await m.get('/admin/crm/reports/by-country');
    expect(byCountry.json.rows.map((r: { key: string }) => r.key)).toEqual(['IN']);
  });

  maybe(
    'reveals only THAT a duplicate exists outside the agent’s scope, never what it is',
    async () => {
      const r = await h.as('agent').post('/admin/crm/leads/duplicates', {
        email: `hello@texan-${s}.org`,
      });
      expect(r.json.matches).toEqual([{ matchedOn: ['domain', 'email'], visible: false }]);
      expect(r.text).not.toContain('Texan');
      expect(r.text).not.toContain(ids.us);
    },
  );
});
