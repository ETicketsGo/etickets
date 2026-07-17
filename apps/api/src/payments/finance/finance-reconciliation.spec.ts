import { agingBuckets, detectDiscrepancies, discrepanciesToCsv } from './discrepancy-detectors';
import { FinanceReconciliationService } from './finance-reconciliation.service';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';

describe('detectDiscrepancies', () => {
  it('flags a payment missing at the provider', () => {
    const out = detectDiscrepancies({
      payments: [
        {
          bookingId: 'b1',
          providerRef: 'pi_1',
          provider: 'stripe',
          amountMinor: 1000,
          currency: 'USD',
          providerStatus: null,
        },
      ],
      refunds: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('PAYMENT_MISSING_AT_PROVIDER');
  });

  it('flags amount and currency mismatches', () => {
    const out = detectDiscrepancies({
      payments: [
        {
          bookingId: 'b1',
          providerRef: 'pi_1',
          provider: 'stripe',
          amountMinor: 1000,
          currency: 'USD',
          providerStatus: {
            providerRef: 'pi_1',
            status: 'CAPTURED',
            amountMinor: 900,
            currency: 'EUR',
          },
        },
      ],
      refunds: [],
    });
    expect(out.map((d) => d.type).sort()).toEqual(['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH']);
  });

  it('does not run provider detectors when the lookup was not attempted', () => {
    const out = detectDiscrepancies({
      payments: [
        {
          bookingId: 'b1',
          providerRef: 'pi_1',
          provider: 'stripe',
          amountMinor: 1000,
          currency: 'USD',
        },
      ],
      refunds: [],
    });
    expect(out).toHaveLength(0);
  });

  it('flags a duplicate capture', () => {
    const p = (bookingId: string) => ({
      bookingId,
      providerRef: 'pi_dup',
      provider: 'stripe',
      amountMinor: 1000,
      currency: 'USD',
    });
    const out = detectDiscrepancies({ payments: [p('b1'), p('b2')], refunds: [] });
    expect(out.some((d) => d.type === 'DUPLICATE_CAPTURE')).toBe(true);
  });

  it('flags an over-refund', () => {
    const out = detectDiscrepancies({
      payments: [],
      refunds: [
        {
          bookingId: 'b1',
          provider: 'stripe',
          providerRef: 'rf_1',
          amountMinor: 1500,
          paymentAmountMinor: 1000,
        },
      ],
    });
    expect(out[0].type).toBe('REFUND_MISMATCH');
  });
});

describe('csv + aging helpers', () => {
  it('escapes CSV fields with commas/quotes', () => {
    const csv = discrepanciesToCsv([
      {
        id: 'd1',
        createdAt: new Date('2026-07-14T00:00:00Z'),
        env: 'PRODUCTION',
        type: 'AMOUNT_MISMATCH',
        provider: 'stripe',
        entityRef: 'pi_1',
        amountMinor: 1000,
        currency: 'USD',
        status: 'OPEN',
        assignedToUserId: null,
        resolutionNotes: 'needs "review", urgent',
      },
    ]);
    // Shared injection-safe serializer: CRLF-delimited, every cell quoted.
    expect(csv.split('\r\n')[0]).toBe(
      '"id","createdAt","env","type","provider","entityRef","amountMinor","currency","status","assignedTo","resolutionNotes"',
    );
    expect(csv).toContain('"needs ""review"", urgent"');
  });

  it('buckets by age', () => {
    const now = Date.parse('2026-07-14T00:00:00Z');
    const buckets = agingBuckets(
      [
        { createdAt: new Date(now - 0.5 * 86_400_000) },
        { createdAt: new Date(now - 5 * 86_400_000) },
        { createdAt: new Date(now - 40 * 86_400_000) },
      ],
      now,
    );
    expect(buckets.find((b) => b.bucket === '0-1d')?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === '3-7d')?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === '30d+')?.count).toBe(1);
  });
});

describe('FinanceReconciliationService', () => {
  function make(opts: { existing?: unknown } = {}) {
    const created: Record<string, unknown>[] = [];
    const prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([
          {
            bookingId: 'b1',
            providerRef: 'pi_dup',
            provider: 'stripe',
            amountMinor: 1000,
            currency: 'USD',
          },
          {
            bookingId: 'b2',
            providerRef: 'pi_dup',
            provider: 'stripe',
            amountMinor: 1000,
            currency: 'USD',
          },
        ]),
      },
      refund: { findMany: jest.fn().mockResolvedValue([]) },
      reconciliationDiscrepancy: {
        findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
        create: jest.fn((a: { data: Record<string, unknown> }) => {
          created.push(a.data);
          return Promise.resolve({ id: `d${created.length}`, ...a.data });
        }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 'd1' }),
        update: jest.fn((a: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'd1', ...a.data }),
        ),
      },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const registry = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as PaymentProviderRegistry;
    const config = { get: () => 'PRODUCTION' } as unknown as ConfigService;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return {
      svc: new FinanceReconciliationService(prisma as any, audit, registry, config),
      prisma,
      created,
      audit,
    };
  }

  it('detect files a new discrepancy (duplicate capture) once', async () => {
    const { svc, created } = make();
    const res = await svc.detect(new Date(0), new Date());
    expect(res.created).toBe(1);
    expect(created[0].type).toBe('DUPLICATE_CAPTURE');
  });

  it('detect dedupes against an existing open discrepancy', async () => {
    const { svc } = make({ existing: { id: 'd0' } });
    const res = await svc.detect(new Date(0), new Date());
    expect(res.created).toBe(0);
  });

  it('resolve marks RESOLVED and audits (no auto-correction of records)', async () => {
    const { svc, audit } = make();
    const row = await svc.resolve('d1', 'manually matched', { userId: 'u1' });
    expect(row.status).toBe('RESOLVED');
    expect(audit.record as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_DISCREPANCY_RESOLVED' }),
    );
  });
});
