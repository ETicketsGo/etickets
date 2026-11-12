import {
  AUTH_RECORD_MODELS,
  AUTH_RECORD_RETENTION_DEFAULT_BATCH,
  AUTH_RECORD_RETENTION_DEFAULT_DAYS,
  AuthRecordModel,
  AuthRecordRetentionService,
  parseAuthRecordRetentionConfig,
} from './auth-record-retention.service';

/*
  An in-memory stand-in for the five Prisma delegates. It evaluates the exact filter shapes the
  service builds (AND / OR / { lt } / { in }), so the tests prove the real eligibility filter
  rather than a mock that answers whatever it is asked.
*/
type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const value = row[key];
    const c = cond as { lt?: Date; in?: string[] };
    if (c.in !== undefined) return c.in.includes(value as string);
    if (c.lt !== undefined) {
      return value instanceof Date && value.getTime() < c.lt.getTime();
    }
    throw new Error(`unsupported filter on ${key}`);
  });
}

type Where = Record<string, unknown>;
interface FakeDelegate {
  rows: Row[];
  findManyCalls: number[];
  deleteManyCalls: number;
  count: jest.Mock<Promise<number>, [{ where: Where }]>;
  findMany: jest.Mock<Promise<Array<{ id: string }>>, [{ where: Where; take: number }]>;
  deleteMany: jest.Mock<Promise<{ count: number }>, [{ where: Where }]>;
}

function fakeDelegate(rows: Row[]): FakeDelegate {
  const d: FakeDelegate = {
    rows,
    findManyCalls: [] as number[],
    deleteManyCalls: 0,
    count: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        d.rows.filter((r) => matches(r, where)).length,
    ),
    findMany: jest.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
      d.findManyCalls.push(take);
      return d.rows
        .filter((r) => matches(r, where))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, take)
        .map((r) => ({ id: r.id }));
    }),
    deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      d.deleteManyCalls += 1;
      const before = d.rows.length;
      d.rows = d.rows.filter((r) => !matches(r, where));
      return { count: before - d.rows.length };
    }),
  };
  return d;
}

const NOW = new Date('2026-11-12T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY);

function build(seed: Partial<Record<AuthRecordModel, Row[]>> = {}) {
  const delegates = Object.fromEntries(
    AUTH_RECORD_MODELS.map((m) => [m, fakeDelegate([...(seed[m] ?? [])])]),
  ) as Record<AuthRecordModel, FakeDelegate>;
  const service = new AuthRecordRetentionService(delegates as never);
  return { service, delegates };
}

function standardSeed(): Partial<Record<AuthRecordModel, Row[]>> {
  return {
    phoneOtp: [
      { id: 'otp-old', expiresAt: daysAgo(31), consumedAt: null },
      { id: 'otp-recent', expiresAt: daysAgo(5), consumedAt: null },
      { id: 'otp-live', expiresAt: daysAhead(1), consumedAt: null },
      // Consumed long ago but (pathologically) still unexpired: must never be touched.
      { id: 'otp-consumed-live', expiresAt: daysAhead(1), consumedAt: daysAgo(40) },
    ],
    emailVerificationCode: [
      { id: 'evc-old', expiresAt: daysAgo(60), consumedAt: daysAgo(60) },
      { id: 'evc-recent', expiresAt: daysAgo(29), consumedAt: null },
    ],
    passwordResetToken: [
      { id: 'prt-used-old', expiresAt: daysAgo(35), usedAt: daysAgo(35) },
      { id: 'prt-live', expiresAt: daysAhead(0.01), usedAt: null },
    ],
    authHandoff: [{ id: 'ah-old', expiresAt: daysAgo(100), consumedAt: null }],
    guestBookingAccess: [
      { id: 'gba-old', expiresAt: daysAgo(31) },
      { id: 'gba-live', expiresAt: daysAhead(30) },
    ],
  };
}

describe('parseAuthRecordRetentionConfig', () => {
  it('defaults to dry run, 30 days, batches of 1000', () => {
    expect(parseAuthRecordRetentionConfig({})).toEqual({
      enabled: false,
      graceDays: AUTH_RECORD_RETENTION_DEFAULT_DAYS,
      batchSize: AUTH_RECORD_RETENTION_DEFAULT_BATCH,
    });
    expect(AUTH_RECORD_RETENTION_DEFAULT_DAYS).toBe(30);
  });

  it.each([
    '',
    '  ',
    'abc',
    '-5',
    '0',
    '1.5',
    '7days',
    'NaN',
    'Infinity',
    '1e3',
    '99999999999999999999',
  ])('falls back to the default for AUTH_RECORD_RETENTION_DAYS=%p', (raw) => {
    expect(parseAuthRecordRetentionConfig({ AUTH_RECORD_RETENTION_DAYS: raw }).graceDays).toBe(30);
    expect(
      parseAuthRecordRetentionConfig({ AUTH_RECORD_RETENTION_BATCH_SIZE: raw }).batchSize,
    ).toBe(1000);
  });

  it('accepts a valid positive integer', () => {
    expect(parseAuthRecordRetentionConfig({ AUTH_RECORD_RETENTION_DAYS: ' 45 ' }).graceDays).toBe(
      45,
    );
    expect(
      parseAuthRecordRetentionConfig({ AUTH_RECORD_RETENTION_BATCH_SIZE: '50' }).batchSize,
    ).toBe(50);
  });

  it('caps the batch size', () => {
    expect(
      parseAuthRecordRetentionConfig({ AUTH_RECORD_RETENTION_BATCH_SIZE: '1000000' }).batchSize,
    ).toBe(10_000);
  });

  it.each(['1', 'yes', 'TRUE ', 'on', 'false', ''])(
    'enables deletion only for the literal "true" (RETENTION_PURGE_ENABLED=%p)',
    (raw) => {
      const enabled = parseAuthRecordRetentionConfig({ RETENTION_PURGE_ENABLED: raw }).enabled;
      expect(enabled).toBe(raw.trim().toLowerCase() === 'true');
    },
  );
});

describe('AuthRecordRetentionService', () => {
  it('dry run counts eligible rows and deletes nothing', async () => {
    const { service, delegates } = build(standardSeed());
    const report = await service.run(NOW, { enabled: false, graceDays: 30, batchSize: 1000 });

    expect(report.mode).toBe('dry-run');
    expect(report.counts).toEqual({
      phoneOtp: 1,
      emailVerificationCode: 1,
      passwordResetToken: 1,
      authHandoff: 1,
      guestBookingAccess: 1,
    });
    expect(report.total).toBe(5);
    for (const m of AUTH_RECORD_MODELS) {
      expect(delegates[m].deleteMany).not.toHaveBeenCalled();
      expect(delegates[m].findMany).not.toHaveBeenCalled();
    }
    expect(delegates.phoneOtp.rows).toHaveLength(4);
  });

  it('the default config (no env) is a dry run', async () => {
    const saved = process.env.RETENTION_PURGE_ENABLED;
    delete process.env.RETENTION_PURGE_ENABLED;
    try {
      const { service, delegates } = build(standardSeed());
      const report = await service.run(NOW);
      expect(report.mode).toBe('dry-run');
      for (const m of AUTH_RECORD_MODELS) expect(delegates[m].deleteMany).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.RETENTION_PURGE_ENABLED = saved;
    }
  });

  it('enabled deletes only rows expired (or spent) beyond the grace period', async () => {
    const { service, delegates } = build(standardSeed());
    const report = await service.run(NOW, { enabled: true, graceDays: 30, batchSize: 1000 });

    expect(report.mode).toBe('enabled');
    expect(report.total).toBe(5);
    expect(delegates.phoneOtp.rows.map((r) => r.id).sort()).toEqual([
      'otp-consumed-live',
      'otp-live',
      'otp-recent',
    ]);
    expect(delegates.emailVerificationCode.rows.map((r) => r.id)).toEqual(['evc-recent']);
    expect(delegates.passwordResetToken.rows.map((r) => r.id)).toEqual(['prt-live']);
    expect(delegates.authHandoff.rows).toEqual([]);
    expect(delegates.guestBookingAccess.rows.map((r) => r.id)).toEqual(['gba-live']);
  });

  it('never deletes an unexpired record, whatever the grace period', async () => {
    const { service, delegates } = build(standardSeed());
    await service.run(NOW, { enabled: true, graceDays: 1, batchSize: 1000 });
    expect(delegates.phoneOtp.rows.map((r) => r.id)).toEqual(
      expect.arrayContaining(['otp-live', 'otp-consumed-live']),
    );
    expect(delegates.passwordResetToken.rows.map((r) => r.id)).toEqual(['prt-live']);
    expect(delegates.guestBookingAccess.rows.map((r) => r.id)).toEqual(['gba-live']);
  });

  it('deletes in bounded batches until the backlog is gone', async () => {
    const backlog: Row[] = Array.from({ length: 2503 }, (_, i) => ({
      id: `otp-${String(i).padStart(5, '0')}`,
      expiresAt: daysAgo(90),
      consumedAt: null,
    }));
    backlog.push({ id: 'zz-live', expiresAt: daysAhead(1), consumedAt: null });
    const { service, delegates } = build({ phoneOtp: backlog });

    const report = await service.run(NOW, { enabled: true, graceDays: 30, batchSize: 1000 });

    expect(report.counts.phoneOtp).toBe(2503);
    expect(report.truncated).toBe(false);
    // 1000 + 1000 + 503: three statements, each limited to one batch of ids.
    expect(delegates.phoneOtp.deleteManyCalls).toBe(3);
    expect(delegates.phoneOtp.findManyCalls.every((take) => take === 1000)).toBe(true);
    for (const call of delegates.phoneOtp.deleteMany.mock.calls) {
      const ids = (call[0].where.AND as Array<{ id?: { in: string[] } }>)[0].id!.in;
      expect(ids.length).toBeLessThanOrEqual(1000);
    }
    expect(delegates.phoneOtp.rows.map((r) => r.id)).toEqual(['zz-live']);
  });

  it('stops at the per-run batch cap and reports truncation', async () => {
    const backlog: Row[] = Array.from({ length: 600 }, (_, i) => ({
      id: `otp-${String(i).padStart(4, '0')}`,
      expiresAt: daysAgo(90),
      consumedAt: null,
    }));
    const { service, delegates } = build({ phoneOtp: backlog });
    const report = await service.run(NOW, { enabled: true, graceDays: 30, batchSize: 1 });
    expect(report.truncated).toBe(true);
    expect(report.counts.phoneOtp).toBe(500);
    expect(delegates.phoneOtp.rows).toHaveLength(100);
  });

  it('the report carries counts only, no identifying data', async () => {
    const { service } = build({
      phoneOtp: [{ id: 'x', expiresAt: daysAgo(99), consumedAt: null, phone: '+15551234567' }],
    });
    const report = await service.run(NOW, { enabled: false, graceDays: 30, batchSize: 1000 });
    const text = JSON.stringify(report);
    expect(text).not.toContain('+1555');
    expect(Object.keys(report).sort()).toEqual(
      ['counts', 'cutoff', 'graceDays', 'mode', 'total', 'truncated'].sort(),
    );
  });
});
