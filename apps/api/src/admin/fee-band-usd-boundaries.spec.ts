import { HttpStatus } from '@nestjs/common';
import { AdminService } from './admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { coverageGaps, describeGap, uncoveredRange } from './fee-band-coverage';

/**
 * Production report (US, USD): changing the "$100 and above" band was refused with "would leave
 * orders between $99.99 and $1,000.00 with no USD band" while the table showed the band starting
 * at $100.
 *
 * The edit was the first step of a reorganisation: turn "$100 and above" into "$1,000 and above",
 * then add "$100 - $999.99". The refusal itself is right for a one-band-at-a-time edit (that step
 * really would leave $100.00 - $999.99 unpriced). The message was wrong: it printed the COVERED
 * amounts either side of the hole ($99.99 is priced by "$0 - $99.99", $1,000.00 by the edited
 * band), so it named amounts that are priced and contradicted the table.
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
  feeType: string;
  feePercentBps: number | null;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
};

const usd = (id: string, minMinor: number, maxMinor: number | null): Row => ({
  id,
  label: `stored ${id}`,
  minMinor,
  maxMinor,
  feeMinor: 199,
  currency: 'USD',
  country: 'United States',
  region: '*',
  active: true,
  deletedAt: null,
  feeType: 'FLAT',
  feePercentBps: null,
  minFeeMinor: null,
  maxFeeMinor: null,
});

const US = [usd('low', 0, 9_999), usd('high', 10_000, null)];

function make(rows: Row[]) {
  const update = jest.fn();
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
              r.currency === where.currency &&
              (where.active === undefined || r.active === where.active) &&
              (where.id?.not === undefined || r.id !== where.id.not) &&
              (where.country === undefined || r.country === where.country) &&
              (where.region === undefined || r.region === where.region),
          ),
        ),
      update,
    },
  } as unknown as PrismaService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { svc: new AdminService(prisma, audit), update };
}

async function refusal(p: Promise<unknown>): Promise<AppException> {
  try {
    await p;
  } catch (err) {
    return err as AppException;
  }
  throw new Error('expected a refusal');
}

describe('USD band edits - the uncovered range is named by the amounts that are uncovered', () => {
  it('editing "$100 and above" into "$1,000 and above" names $100.00 to $999.99', async () => {
    const { svc, update } = make(US);
    const err = await refusal(svc.updateFeeRule('admin', 'high', { minMinor: 100_000 }));
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.message).toContain('orders from $100.00 to $999.99');
    // The old message named the priced neighbours, which the table contradicted.
    expect(err.message).not.toContain('$99.99');
    expect(err.message).not.toContain('$1,000.00');
    expect(update).not.toHaveBeenCalled();
  });

  it('deleting the top band names "$100.00 and above"', async () => {
    const { svc } = make(US);
    const err = await refusal(svc.deleteFeeRule('admin', 'high'));
    expect(err.message).toContain('orders of $100.00 and above');
  });

  it('deleting the first band names "$0.00 to $99.99"', async () => {
    const { svc } = make(US);
    const err = await refusal(svc.deleteFeeRule('admin', 'low'));
    expect(err.message).toContain('orders from $0.00 to $99.99');
  });
});

describe('USD cent boundaries in the coverage maths', () => {
  it('$0.00 - $99.99 then $100.00 and above is continuous', () => {
    expect(coverageGaps(US, 'USD')).toEqual([]);
  });

  it('a hole between $99.99 and $1,000.00 is the range $100.00 - $999.99', () => {
    const gaps = coverageGaps([usd('a', 0, 9_999), usd('b', 100_000, null)], 'USD');
    expect(gaps).toEqual([{ afterMinor: 9_999, beforeMinor: 100_000 }]);
    expect(uncoveredRange(gaps[0])).toEqual({ fromMinor: 10_000, toMinor: 99_999 });
    expect(describeGap(gaps[0], 'USD')).toBe('orders from $100.00 to $999.99');
  });

  it('a schedule starting above $0.00 is uncovered from $0.00', () => {
    const gaps = coverageGaps([usd('a', 10_000, null)], 'USD');
    expect(describeGap(gaps[0], 'USD')).toBe('orders from $0.00 to $99.99');
  });
});
