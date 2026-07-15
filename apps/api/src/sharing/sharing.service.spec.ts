import { SharingService } from './sharing.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { ShareableResourceRegistry } from './shareable-resource.registry';
import type { ShareableResource, ShareView } from './shareable-resource';
import type { RequestUser } from '../common/decorators';

const OWNER: RequestUser = {
  id: 'owner-1',
  email: 'o@e.test',
  fullName: 'Owner',
  roles: ['CUSTOMER'] as never,
};
const STRANGER: RequestUser = {
  id: 'x-1',
  email: 'x@e.test',
  fullName: 'X',
  roles: ['CUSTOMER'] as never,
};

const view: ShareView = {
  resourceType: 'TICKET',
  title: 'DevConf India 2026',
  subtitle: 'VIP',
  status: 'ACTIVE',
  reference: 'ETG-IND-2026-000001',
  ticketType: 'VIP',
  attendeeName: 'Ada',
  seatLabel: null,
  venueName: 'Hall A',
  screenName: null,
  cinemaName: null,
  startsAt: '2026-09-01T10:00:00.000Z',
  endsAt: '2026-09-01T13:00:00.000Z',
};

function fakeResource(
  over: Partial<{ owner: string | null; live: boolean }> = {},
): ShareableResource {
  const live = over.live ?? true;
  return {
    resourceType: 'TICKET',
    id: 'tk1',
    organizationId: 'org1',
    ownerUserId: over.owner === undefined ? 'owner-1' : over.owner,
    status: live ? 'ACTIVE' : 'CHECKED_IN',
    endsAt: new Date('2026-09-01T13:00:00.000Z'),
    canShowLiveQr: (p) => p === 'GUEST' && live,
    canCheckIn: (p) => p === 'GUEST' && live,
    canTransfer: (p) => p === 'TRANSFER' && live,
    canDownload: () => false,
    liveQrToken: () => (live ? 'signed-live-token' : null),
    toShareView: () => view,
  };
}

function setup(
  opts: { resource?: ShareableResource | null; invite?: Record<string, unknown> | null } = {},
) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const prisma = {
    ticketInvite: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return { id: 'sh1', ...a.data };
      }),
      findUnique: jest.fn().mockResolvedValue(opts.invite ?? null),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updated.push(a.data);
        return { id: 'sh1', ...a.data };
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ticket: { findUnique: jest.fn().mockResolvedValue({ booking: { userId: 'owner-1' } }) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService;
  const config = { get: () => 'http://localhost:3000' } as never;
  const registry = {
    resolve: jest
      .fn()
      .mockResolvedValue(opts.resource === undefined ? fakeResource() : opts.resource),
  } as unknown as ShareableResourceRegistry;
  const svc = new SharingService(
    prisma as unknown as PrismaService,
    audit,
    notifications,
    config,
    registry,
  );
  return { svc, prisma, audit, notifications, created, updated };
}

const activeShare = (over: Record<string, unknown> = {}) => ({
  id: 'sh1',
  ticketId: 'tk1',
  organizationId: 'org1',
  permission: 'VIEW',
  resourceType: 'TICKET',
  status: 'PENDING',
  openCount: 0,
  maxOpens: null,
  createdByUserId: 'owner-1',
  expiresAt: new Date(Date.now() + 3_600_000),
  ...over,
});

describe('SharingService', () => {
  describe('createShare', () => {
    it('creates a VIEW share with a link + QR and stores only a token hash', async () => {
      const { svc, created } = setup();
      const res = await svc.createShare(OWNER, 'TICKET', 'tk1', {
        permission: 'VIEW',
        expiry: '24h',
      });
      expect(res.shareUrl).toContain('/share/');
      expect(res.qrDataUrl.startsWith('data:image/png')).toBe(true);
      expect(created[0].permission).toBe('VIEW');
      expect(String(created[0].tokenHash)).not.toBe(res.token); // hashed at rest
    });

    it('rejects a non-owner', async () => {
      const { svc } = setup();
      await expect(
        svc.createShare(STRANGER, 'TICKET', 'tk1', { permission: 'VIEW', expiry: '24h' }),
      ).rejects.toThrow(/owner/i);
    });

    it('refuses guest access on a non-live resource', async () => {
      const { svc } = setup({ resource: fakeResource({ live: false }) });
      await expect(
        svc.createShare(OWNER, 'TICKET', 'tk1', { permission: 'GUEST', expiry: '1h' }),
      ).rejects.toThrow(/guest access or transfer/i);
    });
  });

  describe('resolveShare', () => {
    it('VIEW hides the live QR and cannot check in; counts the open', async () => {
      const { svc, prisma } = setup({ invite: activeShare({ permission: 'VIEW' }) });
      const res = await svc.resolveShare('raw', {});
      expect(res.qrDataUrl).toBeNull();
      expect(res.canCheckIn).toBe(false);
      expect(res.resource.title).toBe('DevConf India 2026');
      expect(prisma.ticketInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ openCount: { increment: 1 } }) }),
      );
    });

    it('GUEST exposes the single live QR and allows check-in', async () => {
      const { svc } = setup({ invite: activeShare({ permission: 'GUEST' }) });
      const res = await svc.resolveShare('raw', {});
      expect(res.qrDataUrl && res.qrDataUrl.startsWith('data:image/png')).toBe(true);
      expect(res.canCheckIn).toBe(true);
    });

    it('rejects a revoked share', async () => {
      const { svc } = setup({ invite: activeShare({ status: 'REVOKED' }) });
      await expect(svc.resolveShare('raw', {})).rejects.toThrow(/revoked/i);
    });

    it('rejects and marks an expired share', async () => {
      const { svc, prisma } = setup({
        invite: activeShare({ expiresAt: new Date(Date.now() - 1000) }),
      });
      await expect(svc.resolveShare('raw', {})).rejects.toThrow(/expired/i);
      expect(prisma.ticketInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'EXPIRED' }) }),
      );
    });

    it('rejects once the open limit is reached', async () => {
      const { svc } = setup({ invite: activeShare({ maxOpens: 2, openCount: 2 }) });
      await expect(svc.resolveShare('raw', {})).rejects.toThrow(/open limit/i);
    });

    it('rejects an unknown token (enumeration/replay)', async () => {
      const { svc } = setup({ invite: null });
      await expect(svc.resolveShare('nope', {})).rejects.toThrow(/not valid/i);
    });
  });

  describe('revoke', () => {
    it('revokes for the owner and blocks a stranger', async () => {
      const { svc, prisma } = setup();
      prisma.ticketInvite.findUnique.mockResolvedValue({
        id: 'sh1',
        ticketId: 'tk1',
        organizationId: 'org1',
        ticket: { booking: { userId: 'owner-1' } },
      });
      const res = await svc.revoke(OWNER, 'sh1');
      expect(res.status).toBe('REVOKED');
      await expect(svc.revoke(STRANGER, 'sh1')).rejects.toThrow(/not your share/i);
    });
  });
});
