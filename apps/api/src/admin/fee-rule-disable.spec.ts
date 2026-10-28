import { AdminService } from './admin.service';
import { coverageImpact } from './fee-band-coverage';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

/**
 * Owner decision 2026-10-29: switching a band off - or any edit that takes coverage away (a
 * narrower range, another country or state) - is checked exactly like a delete. Refused with
 * 409 when it leaves the band's place with no band, or opens a range of orders that no band
 * covers. Gaps that already existed do not block, and an inactive band can always be edited.
 */

const band = (
  id: string,
  minMinor: number,
  maxMinor: number | null,
  extra: Partial<{ country: string; region: string; active: boolean }> = {},
) => ({
  id,
  label: id,
  currency: 'INR',
  minMinor,
  maxMinor,
  feeMinor: 500,
  feeType: 'FLAT',
  feePercentBps: null,
  minFeeMinor: null,
  maxFeeMinor: null,
  country: '*',
  region: '*',
  active: true,
  deletedAt: null,
  ...extra,
});

/** The seeded INR shape: Rs 0-199, Rs 200-499, Rs 500-999, Rs 1,000 and above. */
const SCHEDULE = [
  band('b1', 0, 19_900),
  band('b2', 20_000, 49_900),
  band('b3', 50_000, 99_900),
  band('b4', 100_000, null),
];

function make(target: ReturnType<typeof band>, all: ReturnType<typeof band>[] = SCHEDULE) {
  const update = jest.fn().mockImplementation(({ data }) => ({ ...target, ...data }));
  const findMany = jest
    .fn()
    .mockImplementation(({ where }) =>
      all.filter(
        (b) =>
          b.active &&
          (where.id?.not === undefined || b.id !== where.id.not) &&
          (where.country === undefined || b.country === where.country) &&
          (where.region === undefined || b.region === where.region),
      ),
    );
  const prisma = {
    feeRule: { findUnique: jest.fn().mockResolvedValue(target), findMany, update },
  } as unknown as PrismaService;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { svc: new AdminService(prisma, audit), update };
}

const conflict = (reason: 'GAP' | 'NO_BAND_LEFT') =>
  expect.objectContaining({ status: 409, details: expect.objectContaining({ reason }) });

describe('AdminService.updateFeeRule - coverage when a band is switched off or narrowed', () => {
  it('refuses switching off a middle band (409, names the gap)', async () => {
    const { svc, update } = make(SCHEDULE[1]);
    const attempt = svc.updateFeeRule('admin', 'b2', { active: false });
    await expect(attempt).rejects.toMatchObject(conflict('GAP'));
    await expect(svc.updateFeeRule('admin', 'b2', { active: false })).rejects.toThrow(
      /Switching off "Tickets ₹200 - ₹499" would leave orders between ₹199 and ₹500 with no INR band/,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses switching off the only band of a place (409, no band left)', async () => {
    const only = band('only', 0, null, { country: 'India', region: 'Goa' });
    const { svc, update } = make(only, [only]);
    await expect(svc.updateFeeRule('admin', 'only', { active: false })).rejects.toMatchObject(
      conflict('NO_BAND_LEFT'),
    );
    await expect(svc.updateFeeRule('admin', 'only', { active: false })).rejects.toThrow(
      /last active INR band for Goa, India\. Switching it off would leave no band there/,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses narrowing a band so a range is left uncovered', async () => {
    const { svc } = make(SCHEDULE[1]);
    await expect(svc.updateFeeRule('admin', 'b2', { maxMinor: 30_000 })).rejects.toMatchObject(
      conflict('GAP'),
    );
  });

  it('refuses moving the top band to another state when the old place keeps nothing above it', async () => {
    const { svc } = make(SCHEDULE[3]);
    await expect(
      svc.updateFeeRule('admin', 'b4', { country: 'India', region: 'Kerala' }),
    ).rejects.toMatchObject(conflict('GAP'));
  });

  it('allows switching off a state band the national schedule still covers', async () => {
    const goa = band('goa', 0, null, { country: 'India', region: 'Goa' });
    const { svc, update } = make(goa, [...SCHEDULE, goa]);
    await svc.updateFeeRule('admin', 'goa', { active: false });
    expect(update).toHaveBeenCalled();
  });

  it("judges the band's own place: an India band does not cover the national schedule", async () => {
    const india = band('india', 50_000, null, { country: 'India' });
    const all = [SCHEDULE[0], SCHEDULE[1], india, SCHEDULE[3]];
    // For India the India band still covers Rs 500 and above, but the national top band also
    // prices every other country, where nothing would be left above Rs 999.
    const { svc } = make(SCHEDULE[3], all);
    await expect(svc.updateFeeRule('admin', 'b4', { active: false })).rejects.toMatchObject(
      conflict('GAP'),
    );
  });

  it('does not block on a gap that was already there', async () => {
    // Rs 500-999 is missing already. An edit that leaves that hole as it was is allowed.
    const holey = [SCHEDULE[0], SCHEDULE[1], SCHEDULE[3]];
    const { svc, update } = make(SCHEDULE[3], holey);
    await svc.updateFeeRule('admin', 'b4', { feeMinor: 2_500, active: true });
    expect(update).toHaveBeenCalled();
  });

  it('allows widening a band next to an existing gap (the gap only shrinks)', async () => {
    const holey = [SCHEDULE[0], SCHEDULE[1], SCHEDULE[3]];
    const { svc, update } = make(SCHEDULE[1], holey);
    await svc.updateFeeRule('admin', 'b2', { maxMinor: 70_000 });
    expect(update).toHaveBeenCalled();
  });

  it('always allows editing an inactive band', async () => {
    const off = band('off', 20_000, 49_900, { active: false });
    const { svc, update } = make(off, [SCHEDULE[0], off, SCHEDULE[3]]);
    await svc.updateFeeRule('admin', 'off', { maxMinor: 30_000, feeMinor: 900 });
    expect(update).toHaveBeenCalled();
  });

  it('a change that keeps coverage (fee only) is allowed', async () => {
    const { svc, update } = make(SCHEDULE[1]);
    await svc.updateFeeRule('admin', 'b2', { feeMinor: 1_200 });
    expect(update).toHaveBeenCalled();
  });
});

describe('coverageImpact (pure)', () => {
  it('a delete is the same judgement as switching off', () => {
    const del = coverageImpact(SCHEDULE[1], null, SCHEDULE, 'INR');
    const off = coverageImpact(SCHEDULE[1], { ...SCHEDULE[1], active: false }, SCHEDULE, 'INR');
    expect(off).toEqual(del);
    expect(del).toMatchObject({ ok: false, reason: 'GAP' });
  });

  it('only the old place is judged: a band moved from the nation to a state', () => {
    const impact = coverageImpact(
      SCHEDULE[0],
      { ...SCHEDULE[0], country: 'India', region: 'Goa' },
      SCHEDULE,
      'INR',
    );
    expect(impact).toMatchObject({ ok: false, reason: 'GAP' });
  });

  it('a band moved from a state to the nation keeps the state covered', () => {
    const goa = band('goa', 0, null, { country: 'India', region: 'Goa' });
    expect(coverageImpact(goa, { ...goa, country: '*', region: '*' }, [goa], 'INR')).toEqual({
      ok: true,
    });
  });
});
