/**
 * Live offline-drill harness (M11), at the service-integration level. Exercises
 * the REAL OfflineReconciliationService against a stateful DB simulation so the
 * two-device-conflict, device-loss, reconciliation-mix and connectivity-flapping
 * outcomes are proven deterministically in CI. Results are machine-readable (Jest
 * pass/fail). Browser-level live drills remain a documented prerequisite before
 * activation GO (see docs/guides/LIVE-DRILLS.md).
 */
import { OfflineReconciliationService } from './offline-reconciliation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import type { RequestUser } from '../../common/decorators';
import type { QueuedCheckIn } from '@eticketsgo/shared-types';

const STAFF: RequestUser = {
  id: 'u1',
  email: 's@e.test',
  fullName: 'Staff',
  roles: ['ORGANIZER_OWNER'] as never,
};
const access = {
  assertMember: jest.fn().mockResolvedValue(undefined),
} as unknown as OrgAccessService;
const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

interface TicketState {
  status: string;
  nonce: string;
  qrVersion: number;
  eventSessionId: string;
  checkIns: { deviceInfo: string | null; result: string; reversed: boolean }[];
}

/** A stateful Prisma double: the atomic ACTIVE→CHECKED_IN claim is honoured. */
function statefulPrisma(
  tickets: Map<string, TicketState>,
  devices: Map<string, { organizationId: string; status: string }>,
) {
  return {
    checkInDevice: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(devices.get(where.id) ? { id: where.id, ...devices.get(where.id)! } : null),
      update: () => Promise.resolve({}),
    },
    ticket: {
      findUnique: ({ where }: { where: { id: string } }) => {
        const t = tickets.get(where.id);
        return Promise.resolve(t ? { id: where.id, ...t, checkIns: t.checkIns.slice(0, 1) } : null);
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: { status: string };
      }) => {
        const t = tickets.get(where.id);
        if (t && t.status === where.status) {
          t.status = data.status;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      },
    },
    checkIn: {
      create: ({ data }: { data: { ticketId: string; deviceInfo: string | null } }) => {
        tickets
          .get(data.ticketId)!
          .checkIns.unshift({ deviceInfo: data.deviceInfo, result: 'SUCCESS', reversed: false });
        return Promise.resolve({});
      },
    },
  } as unknown as PrismaService;
}

const queued = (over: Partial<QueuedCheckIn> & { deviceId: string }): QueuedCheckIn => ({
  ticketId: 'tk1',
  nonce: 'n1',
  version: 1,
  eventSessionId: 'se1',
  checkedInAt: 1,
  wasOverride: false,
  ...over,
});

const activeTicket = (over: Partial<TicketState> = {}): TicketState => ({
  status: 'ACTIVE',
  nonce: 'n1',
  qrVersion: 1,
  eventSessionId: 'se1',
  checkIns: [],
  ...over,
});

describe('Offline drill: two-device conflict', () => {
  it('accepts exactly ONE of two devices scanning the same ticket', async () => {
    const tickets = new Map([['tk1', activeTicket()]]);
    const devices = new Map([
      ['devA', { organizationId: 'org1', status: 'ACTIVE' }],
      ['devB', { organizationId: 'org1', status: 'ACTIVE' }],
    ]);
    const svc = new OfflineReconciliationService(statefulPrisma(tickets, devices), access, audit);

    const a = await svc.reconcile(STAFF, 'devA', [queued({ deviceId: 'devA' })]);
    const b = await svc.reconcile(STAFF, 'devB', [queued({ deviceId: 'devB' })]);

    expect(a[0].outcome).toBe('ACCEPTED');
    expect(b[0].outcome).toBe('DUPLICATE_OTHER_DEVICE');
    expect(tickets.get('tk1')!.checkIns).toHaveLength(1); // no double check-in
  });
});

describe('Offline drill: device-loss', () => {
  it('rejects a revoked device’s queued check-ins', async () => {
    const tickets = new Map([['tk1', activeTicket()]]);
    const devices = new Map([['devLost', { organizationId: 'org1', status: 'REVOKED' }]]);
    const svc = new OfflineReconciliationService(statefulPrisma(tickets, devices), access, audit);
    await expect(
      svc.reconcile(STAFF, 'devLost', [queued({ deviceId: 'devLost' })]),
    ).rejects.toThrow(/revoked/i);
    expect(tickets.get('tk1')!.status).toBe('ACTIVE'); // never admitted
  });
});

describe('Offline drill: reconciliation mix', () => {
  it('classifies valid, refunded, transferred and wrong-session records correctly', async () => {
    const tickets = new Map<string, TicketState>([
      ['ok', activeTicket()],
      ['refunded', activeTicket({ status: 'REFUNDED' })],
      ['transferred', activeTicket({ nonce: 'ROTATED', qrVersion: 2 })],
      ['wrongSession', activeTicket({ eventSessionId: 'seX' })],
    ]);
    const devices = new Map([['devA', { organizationId: 'org1', status: 'ACTIVE' }]]);
    const svc = new OfflineReconciliationService(statefulPrisma(tickets, devices), access, audit);

    const res = await svc.reconcile(STAFF, 'devA', [
      queued({ deviceId: 'devA', ticketId: 'ok' }),
      queued({ deviceId: 'devA', ticketId: 'refunded' }),
      queued({ deviceId: 'devA', ticketId: 'transferred' }),
      queued({ deviceId: 'devA', ticketId: 'wrongSession' }),
    ]);
    const byId = Object.fromEntries(res.map((r) => [r.ticketId, r.outcome]));
    expect(byId).toEqual({
      ok: 'ACCEPTED',
      refunded: 'REFUNDED_AFTER_DOWNLOAD',
      transferred: 'TRANSFERRED_AFTER_DOWNLOAD',
      wrongSession: 'WRONG_SESSION',
    });
  });
});

describe('Offline drill: connectivity flapping (idempotency)', () => {
  it('re-submitting the same accepted check-in is a same-device duplicate, not a double', async () => {
    const tickets = new Map([['tk1', activeTicket()]]);
    const devices = new Map([['devA', { organizationId: 'org1', status: 'ACTIVE' }]]);
    const svc = new OfflineReconciliationService(statefulPrisma(tickets, devices), access, audit);

    const first = await svc.reconcile(STAFF, 'devA', [queued({ deviceId: 'devA' })]);
    const retry = await svc.reconcile(STAFF, 'devA', [queued({ deviceId: 'devA' })]);

    expect(first[0].outcome).toBe('ACCEPTED');
    expect(retry[0].outcome).toBe('DUPLICATE_SAME_DEVICE');
    expect(tickets.get('tk1')!.checkIns).toHaveLength(1);
  });
});
