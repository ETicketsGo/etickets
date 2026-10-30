import { FeeSchedulesService } from './fee-schedules.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { scheduleFingerprint } from '../pricing/fee-schedule-fingerprint';
import type { ScheduleBand } from './fee-schedule-validation';

/**
 * Draft -> publish against an in-memory store that behaves like the two tables: the live bands
 * do not move until a publish, a publish writes everything or nothing, and a publish from a
 * schedule that moved on is refused.
 */

type Rule = {
  id: string;
  label: string;
  currency: string;
  minMinor: number;
  maxMinor: number | null;
  feeMinor: number;
  feeType: string;
  feePercentBps: number | null;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
  country: string;
  region: string;
  active: boolean;
  deletedAt: Date | null;
  deletedByUserId: string | null;
};
type Draft = {
  id: string;
  currency: string;
  status: 'OPEN' | 'PUBLISHED' | 'DISCARDED';
  baseFingerprint: string;
  bands: ScheduleBand[];
  version: number | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  publishedByUserId: string | null;
};

const rule = (
  id: string,
  currency: string,
  minMinor: number,
  maxMinor: number | null,
  feeMinor: number,
  country: string,
): Rule => ({
  id,
  label: id,
  currency,
  minMinor,
  maxMinor,
  feeMinor,
  feeType: 'FLAT',
  feePercentBps: null,
  minFeeMinor: null,
  maxFeeMinor: null,
  country,
  region: '*',
  active: true,
  deletedAt: null,
  deletedByUserId: null,
});

function store() {
  const rules: Rule[] = [
    rule('usd-low', 'USD', 0, 9_999, 199, 'United States'),
    rule('usd-high', 'USD', 10_000, null, 299, 'United States'),
    rule('inr-a', 'INR', 0, 19_900, 500, 'India'),
    rule('inr-b', 'INR', 20_000, null, 1_000, 'India'),
  ];
  const drafts: Draft[] = [];
  let seq = 0;
  const live = (currency: string) =>
    rules
      .filter((r) => r.currency === currency && r.deletedAt === null)
      .sort((a, b) => a.minMinor - b.minMinor);
  const matchDraft = (d: Draft, where: Partial<Draft>) =>
    Object.entries(where).every(([k, v]) => (d as Record<string, unknown>)[k] === v);

  const db = {
    feeRule: {
      findMany: jest.fn(async ({ where }: { where: { currency: string } }) =>
        live(where.currency).map((r) => ({ ...r })),
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Rule> }) => {
        const r = rules.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
      create: jest.fn(async ({ data }: { data: Partial<Rule> }) => {
        const r = { ...rule(`new-${++seq}`, data.currency!, 0, null, 0, '*'), ...data } as Rule;
        rules.push(r);
        return r;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Rule> }) => {
          for (const r of rules) if (where.id.in.includes(r.id)) Object.assign(r, data);
          return { count: where.id.in.length };
        },
      ),
    },
    feeScheduleDraft: {
      findFirst: jest.fn(async ({ where }: { where: Partial<Draft> }) => {
        return drafts.find((d) => matchDraft(d, where)) ?? null;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const d = drafts.find((x) => x.id === where.id);
        return d ? { ...d, bands: JSON.parse(JSON.stringify(d.bands)) } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Partial<Draft> }) =>
        drafts
          .filter((d) => matchDraft(d, where))
          .sort((a, b) => (b.version ?? 0) - (a.version ?? 0)),
      ),
      create: jest.fn(async ({ data }: { data: Partial<Draft> }) => {
        const d = {
          id: `d${++seq}`,
          status: 'OPEN',
          version: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          publishedAt: null,
          publishedByUserId: null,
          ...data,
        } as Draft;
        drafts.push(d);
        return d;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Draft> }) => {
        const d = drafts.find((x) => x.id === where.id)!;
        if (
          data.version != null &&
          drafts.some((o) => o !== d && o.currency === d.currency && o.version === data.version)
        ) {
          throw new Error('unique constraint (currency, version)');
        }
        Object.assign(d, data);
        return d;
      }),
      aggregate: jest.fn(async ({ where }: { where: Partial<Draft> }) => ({
        _max: {
          version: drafts
            .filter((d) => matchDraft(d, where))
            .reduce<number | null>((m, d) => Math.max(m ?? 0, d.version ?? 0), null),
        },
      })),
    },
    $executeRaw: jest.fn(async () => 1),
    auditLog: { create: jest.fn() },
  };
  /*
    All-or-nothing: the transaction runs against a copy, and the copy replaces the store only
    when the callback returns. A throw leaves the store exactly as it was.
  */
  const prisma = {
    ...db,
    $transaction: jest.fn(async (fn: (tx: typeof db) => Promise<unknown>) => {
      const rulesBefore = JSON.parse(JSON.stringify(rules));
      const draftsBefore = drafts.map((d) => ({ ...d }));
      try {
        return await fn(db);
      } catch (err) {
        rules.splice(0, rules.length, ...rulesBefore);
        drafts.splice(0, drafts.length, ...draftsBefore);
        throw err;
      }
    }),
  };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordInTransaction: jest.fn().mockResolvedValue(undefined),
    afterCommit: jest.fn(),
  };
  const svc = new FeeSchedulesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { svc, rules, drafts, audit, live, db };
}

const snapshot = (rules: Rule[]) => JSON.stringify(rules);

describe('FeeSchedulesService', () => {
  it('a draft copies the live bands and changes nothing live while it is edited', async () => {
    const { svc, rules, db } = store();
    const before = snapshot(rules);
    const draft = await svc.createDraft('admin', 'USD');
    expect(draft.bands.map((b) => b.sourceId)).toEqual(['usd-low', 'usd-high']);
    // Broken on purpose: a gap. Allowed in a draft, reported, nothing written live.
    const saved = await svc.saveDraft('admin', draft.id, [
      { ...draft.bands[0] },
      { ...draft.bands[1], minMinor: 100_000 },
    ]);
    expect(saved.validation.valid).toBe(false);
    expect(saved.validation.issues[0].message).toContain('orders from $100.00 to $999.99');
    expect(snapshot(rules)).toBe(before);
    expect(db.feeRule.update).not.toHaveBeenCalled();
    expect(db.feeRule.create).not.toHaveBeenCalled();
  });

  it('opening a draft again returns the one already open', async () => {
    const { svc } = store();
    const a = await svc.createDraft('admin', 'USD');
    const b = await svc.createDraft('other-admin', 'USD');
    expect(b.id).toBe(a.id);
  });

  it('publishes a reorganisation in one go: update, add, and version 1', async () => {
    const { svc, live, audit } = store();
    const draft = await svc.createDraft('admin', 'USD');
    const [low, high] = draft.bands;
    await svc.saveDraft('admin', draft.id, [
      low,
      { ...high, maxMinor: 99_999 },
      { ...high, key: 'new', sourceId: null, minMinor: 100_000, maxMinor: null, feeMinor: 499 },
    ]);
    const result = await svc.publish('admin', draft.id);
    expect(result).toMatchObject({ version: 1, created: 1, updated: 1, deleted: 0 });
    expect(live('USD').map((r) => [r.minMinor, r.maxMinor, r.feeMinor])).toEqual([
      [0, 9_999, 199],
      [10_000, 99_999, 299],
      [100_000, null, 499],
    ]);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'FEE_SCHEDULE_PUBLISHED',
        metadata: expect.objectContaining({ currency: 'USD', version: 1 }),
      }),
    );
    expect(audit.afterCommit).toHaveBeenCalledTimes(1);
  });

  it('replacing several bands with one soft-deletes the rest', async () => {
    const { svc, live, rules } = store();
    const draft = await svc.createDraft('admin', 'USD');
    await svc.saveDraft('admin', draft.id, [{ ...draft.bands[0], maxMinor: null, feeMinor: 250 }]);
    const r = await svc.publish('admin', draft.id);
    expect(r).toMatchObject({ updated: 1, deleted: 1, created: 0 });
    expect(live('USD')).toHaveLength(1);
    const gone = rules.find((x) => x.id === 'usd-high')!;
    expect(gone).toMatchObject({ active: false, deletedByUserId: 'admin' });
    expect(gone.deletedAt).toBeInstanceOf(Date);
  });

  it('refuses to publish a draft with errors, and writes nothing', async () => {
    const { svc, rules } = store();
    const draft = await svc.createDraft('admin', 'USD');
    await svc.saveDraft('admin', draft.id, [draft.bands[0]]);
    const before = snapshot(rules);
    await expect(svc.publish('admin', draft.id)).rejects.toMatchObject({
      code: 'FEE_SCHEDULE_INVALID',
      status: 409,
    });
    expect(snapshot(rules)).toBe(before);
  });

  it('refuses a publish when the live schedule changed after the draft was made', async () => {
    const { svc, rules } = store();
    const draft = await svc.createDraft('admin', 'USD');
    // Somebody edits a live band directly in the meantime.
    rules.find((r) => r.id === 'usd-high')!.feeMinor = 350;
    expect((await svc.draft(draft.id)).stale).toBe(true);
    await expect(svc.publish('admin', draft.id)).rejects.toMatchObject({
      code: 'FEE_SCHEDULE_STALE',
      status: 409,
    });
    expect(rules.find((r) => r.id === 'usd-high')!.feeMinor).toBe(350);
  });

  it('two drafts from the same schedule: the first publish wins, the second is refused', async () => {
    const { svc, drafts, live } = store();
    const a = await svc.createDraft('admin-a', 'USD');
    // A second draft made at the same moment, from the same live schedule.
    drafts.push({ ...drafts[0], id: 'd-b', createdByUserId: 'admin-b' });
    await svc.saveDraft('admin-a', a.id, [a.bands[0], { ...a.bands[1], feeMinor: 301 }]);
    await svc.saveDraft('admin-b', 'd-b', [a.bands[0], { ...a.bands[1], feeMinor: 999 }]);
    await svc.publish('admin-a', a.id);
    await expect(svc.publish('admin-b', 'd-b')).rejects.toMatchObject({
      code: 'FEE_SCHEDULE_STALE',
    });
    expect(live('USD')[1].feeMinor).toBe(301);
  });

  it('a published draft cannot be published again, edited, or discarded', async () => {
    const { svc } = store();
    const d = await svc.createDraft('admin', 'USD');
    await svc.saveDraft('admin', d.id, [d.bands[0], { ...d.bands[1], feeMinor: 301 }]);
    await svc.publish('admin', d.id);
    await expect(svc.publish('admin', d.id)).rejects.toMatchObject({ status: 409 });
    await expect(svc.saveDraft('admin', d.id, d.bands)).rejects.toMatchObject({ status: 409 });
    await expect(svc.discardDraft('admin', d.id)).rejects.toMatchObject({ status: 409 });
  });

  it('versions count per currency, and publishing USD leaves INR untouched', async () => {
    const { svc, rules } = store();
    const inrBefore = JSON.stringify(rules.filter((r) => r.currency === 'INR'));
    const first = await svc.createDraft('admin', 'USD');
    await svc.saveDraft('admin', first.id, [first.bands[0], { ...first.bands[1], feeMinor: 301 }]);
    await svc.publish('admin', first.id);
    const second = await svc.createDraft('admin', 'USD');
    await svc.saveDraft('admin', second.id, [
      second.bands[0],
      { ...second.bands[1], feeMinor: 302 },
    ]);
    expect((await svc.publish('admin', second.id)).version).toBe(2);
    expect(JSON.stringify(rules.filter((r) => r.currency === 'INR'))).toBe(inrBefore);
    expect((await svc.overview('USD')).liveVersion).toBe(2);
  });

  it('the live fingerprint a quote carries moves only when a publish lands', async () => {
    const { svc, live } = store();
    const before = scheduleFingerprint(live('USD'));
    const d = await svc.createDraft('admin', 'USD');
    await svc.saveDraft('admin', d.id, [d.bands[0], { ...d.bands[1], feeMinor: 301 }]);
    expect(scheduleFingerprint(live('USD'))).toBe(before);
    await svc.publish('admin', d.id);
    expect(scheduleFingerprint(live('USD'))).not.toBe(before);
  });
});
