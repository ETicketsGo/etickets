import { AttendeesService } from './attendees.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import type { RequestUser } from '../common/decorators';

const OWNER: RequestUser = {
  id: 'owner-1',
  email: 'owner@e.test',
  fullName: 'Olive Owner',
  roles: ['CUSTOMER'] as never,
};
const RECIPIENT: RequestUser = {
  id: 'rec-1',
  email: 'rec@e.test',
  fullName: 'Rita Recipient',
  roles: ['CUSTOMER'] as never,
};
const STRANGER: RequestUser = {
  id: 'x-1',
  email: 'x@e.test',
  fullName: 'Mal',
  roles: ['CUSTOMER'] as never,
};

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tk1',
    organizationId: 'org1',
    status: 'ACTIVE',
    nonce: 'old-nonce',
    qrVersion: 1,
    holderName: 'Olive Owner',
    holderEmail: 'owner@e.test',
    seatLabel: null,
    assignmentStatus: 'ASSIGNED',
    booking: { userId: 'owner-1', reference: 'ETG-IND-2026-000001' },
    ...over,
  };
}

/**
 * Builds the service with a hand-rolled Prisma mock. `tx` mirrors the interactive
 * transaction client; $transaction just invokes the callback with it.
 */
function setup(
  opts: {
    ticket?: Record<string, unknown> | null;
    invite?: Record<string, unknown> | null;
    account?: { id: string } | null;
  } = {},
) {
  const state = {
    ticketUpdate: undefined as undefined | Record<string, unknown>,
    inviteCreate: undefined as undefined | Record<string, unknown>,
  };
  const tx = {
    ticketInvite: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        state.inviteCreate = args.data;
        return { id: 'inv1', status: 'PENDING', ...args.data };
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    ticket: {
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        state.ticketUpdate = args.data;
        return ticketRow({ ...args.data });
      }),
    },
  };
  const prisma = {
    ticket: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.ticket === undefined ? ticketRow() : opts.ticket),
      update: tx.ticket.update,
      findMany: jest.fn().mockResolvedValue([]),
    },
    ticketInvite: {
      findUnique: jest.fn().mockResolvedValue(opts.invite ?? null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findUnique: jest.fn().mockResolvedValue(opts.account ?? null) },
    booking: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue({ userId: 'owner-1', buyerEmail: 'owner@e.test' }),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService;
  const svc = new AttendeesService(prisma as unknown as PrismaService, audit, notifications);
  return { svc, prisma, tx, audit, notifications, state };
}

describe('AttendeesService', () => {
  describe('assign', () => {
    it('sets attendee identity and links an existing account', async () => {
      const { svc, state } = setup({ account: { id: 'rec-1' } });
      const res = await svc.assign(OWNER, 'tk1', { name: 'Rita', email: 'rec@e.test' });
      expect(state.ticketUpdate).toMatchObject({
        holderName: 'Rita',
        holderEmail: 'rec@e.test',
        attendeeUserId: 'rec-1',
        assignmentStatus: 'ASSIGNED',
      });
      expect(res.assignmentStatus).toBe('ASSIGNED');
    });

    it('rejects a non-owner (RBAC)', async () => {
      const { svc } = setup();
      await expect(svc.assign(STRANGER, 'tk1', { name: 'x', email: 'x@e.test' })).rejects.toThrow(
        /owner/i,
      );
    });

    it('refuses to reassign a checked-in ticket', async () => {
      const { svc } = setup({ ticket: ticketRow({ status: 'CHECKED_IN' }) });
      await expect(svc.assign(OWNER, 'tk1', { name: 'x', email: 'x@e.test' })).rejects.toThrow(
        /cannot be reassigned/i,
      );
    });
  });

  describe('invite', () => {
    it('creates a tokenised invite, supersedes prior invites, and returns a claim token', async () => {
      const { svc, tx, notifications } = setup();
      const res = await svc.invite(OWNER, 'tk1', { email: 'rec@e.test' });
      expect(tx.ticketInvite.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'REVOKED' }) }),
      );
      expect(res.token).toBeTruthy();
      // The raw token is NOT what's stored — a hash is.
      expect(
        String((tx.ticketInvite.create as jest.Mock).mock.calls[0][0].data.tokenHash),
      ).not.toBe(res.token);
      expect(notifications.send).toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    const pendingInvite = (over: Record<string, unknown> = {}) => ({
      id: 'inv1',
      ticketId: 'tk1',
      organizationId: 'org1',
      kind: 'INVITE',
      permission: 'TRANSFER',
      status: 'PENDING',
      email: 'rec@e.test',
      expiresAt: new Date(Date.now() + 3_600_000),
      ...over,
    });

    it('relinks the ticket to the recipient and ROTATES the QR nonce', async () => {
      const { svc, prisma, state } = setup({ invite: pendingInvite() });
      // findUnique is used for both invite (by tokenHash) and ticket (by id).
      (prisma.ticketInvite.findUnique as jest.Mock).mockResolvedValue(pendingInvite());
      (prisma.ticket.findUnique as jest.Mock).mockResolvedValue(ticketRow());

      await svc.accept(RECIPIENT, 'raw-token');
      expect(state.ticketUpdate).toMatchObject({
        attendeeUserId: 'rec-1',
        holderEmail: 'rec@e.test',
        assignmentStatus: 'ACCEPTED',
        qrVersion: { increment: 1 },
      });
      // A fresh nonce (≠ old) is written — the previous QR is now invalid.
      expect(state.ticketUpdate!.nonce).toBeTruthy();
      expect(state.ticketUpdate!.nonce).not.toBe('old-nonce');
    });

    it('rejects an unknown / already-used token (replay)', async () => {
      const { svc, prisma } = setup();
      (prisma.ticketInvite.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.accept(RECIPIENT, 'nope')).rejects.toThrow(/no longer valid/i);
    });

    it('refuses to take ownership via a VIEW/GUEST share token (security)', async () => {
      const { svc, prisma } = setup();
      (prisma.ticketInvite.findUnique as jest.Mock).mockResolvedValue(
        pendingInvite({ permission: 'VIEW' }),
      );
      await expect(svc.accept(RECIPIENT, 'view-token')).rejects.toThrow(/ownership/i);
    });

    it('rejects and marks an expired invite', async () => {
      const { svc, prisma } = setup();
      (prisma.ticketInvite.findUnique as jest.Mock).mockResolvedValue(
        pendingInvite({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(svc.accept(RECIPIENT, 'raw')).rejects.toThrow(/expired/i);
      expect(prisma.ticketInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'EXPIRED' }) }),
      );
    });
  });

  describe('unassign', () => {
    it('clears the attendee and rotates the QR', async () => {
      const { svc, state } = setup();
      await svc.unassign(OWNER, 'tk1');
      expect(state.ticketUpdate).toMatchObject({
        assignmentStatus: 'UNASSIGNED',
        attendeeUserId: null,
        qrVersion: { increment: 1 },
      });
      expect(state.ticketUpdate!.nonce).not.toBe('old-nonce');
    });
  });

  /*
    A transfer the giver can undo is not a transfer. Before this, the buyer could unassign a
    ticket they had given away — rotating the QR and cutting the recipient out — reassign it,
    or transfer it a second time, because every check read `booking.userId`.
  */
  describe('after a transfer is accepted', () => {
    const transferredTicket = (over: Record<string, unknown> = {}) =>
      ticketRow({
        attendeeUserId: 'rec-1',
        assignmentStatus: 'ACCEPTED',
        holderEmail: 'rec@e.test',
        invites: [{ acceptedByUserId: 'rec-1' }],
        ...over,
      });

    type Act = (svc: AttendeesService) => Promise<unknown>;
    const acts: [string, Act][] = [
      ['unassign', (svc) => svc.unassign(OWNER, 'tk1')],
      ['assign', (svc) => svc.assign(OWNER, 'tk1', { name: 'x', email: 'x@e.test' })],
      ['invite', (svc) => svc.invite(OWNER, 'tk1', { email: 'x@e.test' })],
      ['transfer', (svc) => svc.transfer(OWNER, 'tk1', { email: 'x@e.test' } as never)],
    ];

    it.each(acts)('the buyer who gave it away can no longer %s it', async (_name, act) => {
      const { svc, prisma, tx } = setup({ ticket: transferredTicket() });
      await expect(act(svc)).rejects.toThrow(/transferred/i);
      // Nothing written — in particular the QR was not rotated out from under the recipient.
      expect(tx.ticket.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is managed by its new holder instead', async () => {
      const { svc, state } = setup({ ticket: transferredTicket() });
      await svc.unassign(RECIPIENT, 'tk1');
      expect(state.ticketUpdate).toMatchObject({ assignmentStatus: 'UNASSIGNED' });
    });

    const acceptedInvite = (kind: string) => ({
      id: 'inv1',
      ticketId: 'tk1',
      organizationId: 'org1',
      kind,
      permission: 'TRANSFER',
      status: 'PENDING',
      email: 'rec@e.test',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    it('revokes every other live link to the ticket when the transfer is accepted', async () => {
      /*
        A guest share the buyer made earlier renders the LIVE QR — which, after the rotation on
        accept, is the recipient's. Left pending, it would hand the buyer the new code anyway.
      */
      const { svc, prisma, tx } = setup();
      (prisma.ticketInvite.findUnique as jest.Mock).mockResolvedValue(acceptedInvite('TRANSFER'));
      await svc.accept(RECIPIENT, 'raw-token');
      expect(tx.ticketInvite.updateMany).toHaveBeenCalledWith({
        where: { ticketId: 'tk1', status: 'PENDING', id: { not: 'inv1' } },
        data: { status: 'REVOKED', resolvedAt: expect.any(Date) },
      });
    });

    it('leaves the owner’s other links alone when an ATTENDEE invite is accepted', async () => {
      // Assigning a seat to a guest is not giving the ticket away.
      const { svc, prisma, tx } = setup();
      (prisma.ticketInvite.findUnique as jest.Mock).mockResolvedValue(acceptedInvite('INVITE'));
      await svc.accept(RECIPIENT, 'raw-token');
      expect(tx.ticketInvite.updateMany).not.toHaveBeenCalled();
    });

    it('keeps the new holder’s onward assignments out of the buyer’s booking summary', async () => {
      const { svc, prisma } = setup();
      prisma.booking.findUnique.mockResolvedValue({ userId: 'owner-1', reference: 'ETG-1' });
      (prisma.ticket.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tk1',
          serial: 'S-1',
          seatLabel: null,
          status: 'ACTIVE',
          assignmentStatus: 'INVITED',
          holderName: 'Fran Friend',
          holderEmail: 'friend@e.test',
          ticketType: { name: 'VIP' },
          invites: [{ id: 'inv9', email: 'friend@e.test', kind: 'INVITE', expiresAt: new Date() }],
        },
      ]);
      (prisma.ticketInvite.findMany as jest.Mock).mockResolvedValue([
        { ticketId: 'tk1', acceptedByUserId: 'rec-1' },
      ]);

      const res = await svc.summaryForBooking(OWNER, 'bk1');
      expect(res.tickets[0].transferred).toBe(true);
      expect(JSON.stringify(res)).not.toContain('friend@e.test');
      expect(JSON.stringify(res)).not.toContain('Fran Friend');
    });
  });
});
