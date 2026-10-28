import { HttpStatus } from '@nestjs/common';
import { AdminService } from './admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';

/**
 * Deleting a fee band, and the name a band is shown under.
 *
 * Delete is soft (switched off, stamped, audited) and refused with 409 when it would leave the
 * band's place with no band or open an uncovered range. The real-Postgres spec repeats the
 * important cases against a database.
 */

type Row = {
  id: string;
  label: string;
  minMinor: number;
  maxMinor: number | null;
  feeMinor: number;
  currency: string;
  country: string;
  region: string;
  active: boolean;
  deletedAt: Date | null;
  feeType?: string;
};

const row = (id: string, minMinor: number, maxMinor: number | null, patch: Partial<Row> = {}) =>
  ({
    id,
    label: `stored ${id}`,
    minMinor,
    maxMinor,
    feeMinor: 500,
    currency: 'INR',
    country: 'India',
    region: '*',
    active: true,
    deletedAt: null,
    feeType: 'FLAT',
    ...patch,
  }) as Row;

const INR = [
  row('a', 0, 19_900),
  row('b', 20_000, 49_900),
  row('c', 50_000, 99_900),
  row('d', 100_000, null),
];

function make(rows: Row[]) {
  const update = jest
    .fn()
    .mockImplementation(({ where, data }) => ({ ...rows.find((r) => r.id === where.id), ...data }));
  const prisma = {
    feeRule: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }) => rows.find((r) => r.id === where.id) ?? null),
      findMany: jest
        .fn()
        .mockImplementation(({ where }) =>
          rows.filter(
            (r) =>
              (where.currency === undefined || r.currency === where.currency) &&
              (where.active === undefined || r.active === where.active) &&
              (where.deletedAt === undefined || r.deletedAt === where.deletedAt),
          ),
        ),
      update,
    },
  } as unknown as PrismaService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { svc: new AdminService(prisma, audit), update, audit };
}

const statusOf = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  return err as AppException;
};

describe('AdminService.deleteFeeRule', () => {
  it('soft-deletes an inactive band: switched off, stamped, audited', async () => {
    const off = row('x', 0, 9_900, { active: false });
    const { svc, update, audit } = make([...INR, off]);
    const out = await svc.deleteFeeRule('admin-1', 'x');

    const data = update.mock.calls[0][0].data;
    expect(data.active).toBe(false);
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.deletedByUserId).toBe('admin-1');
    expect(out.displayLabel).toBe('Tickets ₹0 - ₹99');
    const entry = (audit.record as jest.Mock).mock.calls[0][0];
    expect(entry).toMatchObject({
      action: 'FEE_RULE_DELETED',
      entityType: 'FeeRule',
      entityId: 'x',
      actorUserId: 'admin-1',
    });
    expect(entry.metadata.before).toMatchObject({ minMinor: 0, maxMinor: 9_900, active: false });
    // The stored historical label is recorded, never rewritten.
    expect(entry.metadata.before.label).toBe('stored x');
  });

  it('allows deleting an active band whose range another band covers', async () => {
    const state = row('s', 0, 19_900, { region: 'Telangana' });
    const { svc, update } = make([...INR, state]);
    await svc.deleteFeeRule('admin-1', 's');
    expect(update).toHaveBeenCalled();
  });

  it('refuses a delete that opens a hole, with 409 naming the range', async () => {
    const { svc, update, audit } = make(INR);
    const err = await statusOf(svc.deleteFeeRule('admin-1', 'c'));
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.message).toContain('"Tickets ₹500 - ₹999"');
    expect(err.message).toContain('orders between ₹499 and ₹1,000');
    expect(err.message).toContain('India');
    expect(err.details).toMatchObject({
      reason: 'GAP',
      gaps: [{ afterMinor: 49_900, beforeMinor: 100_000 }],
    });
    expect(update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses deleting the top band ("and above" would have no band)', async () => {
    const { svc } = make(INR);
    const err = await statusOf(svc.deleteFeeRule('admin-1', 'd'));
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.message).toContain('orders above ₹999');
  });

  it('refuses deleting the last band, which would fall back to the built-in defaults', async () => {
    const only = row('u', 0, null, { currency: 'USD', country: 'United States' });
    const { svc } = make([only]);
    const err = await statusOf(svc.deleteFeeRule('admin-1', 'u'));
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.message).toMatch(/last active USD band for United States/);
    expect(err.message).toMatch(/built-in default fees/);
    expect(err.details).toMatchObject({ reason: 'NO_BAND_LEFT' });
  });

  it('answers 404 for an unknown or already deleted band', async () => {
    const gone = row('g', 0, 100, { active: false, deletedAt: new Date() });
    const { svc } = make([gone]);
    expect((await statusOf(svc.deleteFeeRule('admin-1', 'nope'))).getStatus()).toBe(404);
    expect((await statusOf(svc.deleteFeeRule('admin-1', 'g'))).getStatus()).toBe(404);
  });

  it('will not edit a deleted band back to life', async () => {
    const gone = row('g', 0, 100, { active: false, deletedAt: new Date() });
    const { svc, update } = make([gone]);
    const err = await statusOf(svc.updateFeeRule('admin-1', 'g', { active: true }));
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('fee band names and validation', () => {
  it('lists bands with a name written from their boundaries, hiding deleted ones', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([
        row('a', 0, 49_900, { label: '₹0-₹199 (stale)' }),
        row('u', 5_000, null, { currency: 'USD' }),
      ]);
    const svc = new AdminService(
      { feeRule: { findMany } } as unknown as PrismaService,
      {} as AuditService,
    );
    const out = await svc.feeRules();
    expect(findMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
    expect(out.map((r) => r.displayLabel)).toEqual([
      'Tickets ₹0 - ₹499',
      'Tickets $50.00 and above',
    ]);
    // The stored label is history and comes back untouched.
    expect(out[0].label).toBe('₹0-₹199 (stale)');

    await svc.feeRules({ includeDeleted: true });
    expect(findMany.mock.calls[1][0].where).toEqual({});
  });

  it('stores a generated label when none is given on create', async () => {
    const create = jest.fn().mockImplementation(({ data }) => ({ id: 'n', ...data }));
    const svc = new AdminService(
      {
        feeRule: { findMany: jest.fn().mockResolvedValue([]), create },
      } as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );
    await svc.createFeeRule('admin-1', {
      currency: 'USD',
      minMinor: 5_000,
      maxMinor: null,
      feeMinor: 199,
    });
    expect(create.mock.calls[0][0].data.label).toBe('Tickets $50.00 and above');
  });

  it('refuses an overlapping band with 409 and names the other band by its range', async () => {
    const svc = new AdminService(
      {
        feeRule: {
          findMany: jest.fn().mockResolvedValue([row('b', 20_000, 49_900)]),
          create: jest.fn(),
        },
      } as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );
    const err = await statusOf(
      svc.createFeeRule('admin-1', {
        currency: 'INR',
        minMinor: 30_000,
        maxMinor: 60_000,
        feeMinor: 100,
        country: 'India',
      }),
    );
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.message).toContain('"Tickets ₹200 - ₹499"');
    expect(err.details).toMatchObject({ conflictingRuleId: 'b' });
  });

  it('refuses an upper bound at or below the lower bound', async () => {
    const svc = new AdminService(
      { feeRule: { findMany: jest.fn(), create: jest.fn() } } as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );
    await expect(
      svc.createFeeRule('admin-1', { currency: 'INR', minMinor: 500, maxMinor: 400, feeMinor: 1 }),
    ).rejects.toThrow(/greater than the lower bound/);
  });
});
