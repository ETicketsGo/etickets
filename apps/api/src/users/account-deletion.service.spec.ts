import { AccountDeletionService } from './account-deletion.service';
import { AppException } from '../common/errors';

/**
 * Deletion is irreversible and legally load-bearing, so these tests are as much about
 * what SURVIVES as about what is removed.
 */

function makeService(
  opts: {
    user?: unknown;
    ownerCounts?: { organizationId: string; _count: { _all: number } }[];
    consentRows?: unknown[];
    guestBookings?: { id: string }[];
  } = {},
) {
  const tx = {
    organizerFollow: { deleteMany: jest.fn() },
    organizerNotificationPreference: { deleteMany: jest.fn() },
    communicationConsent: {
      findMany: jest.fn().mockResolvedValue(opts.consentRows ?? []),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    refreshToken: { deleteMany: jest.fn() },
    pushSubscription: { deleteMany: jest.fn() },
    userDevice: { deleteMany: jest.fn() },
    notificationPreference: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    review: { deleteMany: jest.fn() },
    organizationMember: { deleteMany: jest.fn() },
    booking: {
      updateMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue(opts.guestBookings ?? []),
    },
    ticket: { updateMany: jest.fn() },
    marketingConsent: { updateMany: jest.fn() },
    ticketInvite: { updateMany: jest.fn() },
    feedback: { updateMany: jest.fn() },
    user: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.user === undefined
            ? { id: 'u_1', email: 'asha@example.test', status: 'ACTIVE', memberships: [] }
            : opts.user,
        ),
    },
    organizationMember: { groupBy: jest.fn().mockResolvedValue(opts.ownerCounts ?? []) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  };

  return { service: new AccountDeletionService(prisma as never), prisma, tx };
}

describe('what is removed', () => {
  it('destroys every session so access ends immediately', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u_1' } });
  });

  it('revokes push devices, subscriptions, prefs, notifications and reviews', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    for (const model of [
      tx.pushSubscription,
      tx.userDevice,
      tx.notificationPreference,
      tx.notification,
      tx.review,
    ]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u_1' } });
    }
  });

  it('revokes organization memberships', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.organizationMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u_1' } });
  });
});

describe('organizer follows and consent', () => {
  it('deletes follows and per-organizer preferences', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.organizerFollow.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u_1' } });
    expect(tx.organizerNotificationPreference.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u_1' },
    });
  });

  it('closes an open organizer email grant, then unlinks the evidence from the account', async () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s));
    const row = (purpose: string, granted: boolean, second: number, organizationId = 'org_a') => ({
      purpose,
      organizationId,
      channel: 'email',
      granted,
      source: 'x',
      policyVersion: null,
      createdAt: at(second),
    });
    const { service, tx } = makeService({
      consentRows: [
        row('ORGANIZER_UPDATES', true, 1),
        // Already withdrawn: no second withdrawal is written for it.
        row('OFFERS', true, 1),
        row('OFFERS', false, 2),
      ],
    });

    await service.deleteMe('u_1');

    expect(tx.communicationConsent.create).toHaveBeenCalledTimes(1);
    expect(tx.communicationConsent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: null,
        organizationId: 'org_a',
        purpose: 'ORGANIZER_UPDATES',
        granted: false,
        source: 'withdrawn-on-account-deletion',
        // The hash of the address, never the address.
        subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
    expect(tx.communicationConsent.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u_1' },
      data: { userId: null },
    });
    expect(tx.communicationConsent).not.toHaveProperty('deleteMany');
  });
});

describe('what is retained, and anonymised', () => {
  it('keeps bookings but strips the personal data from them', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    // updateMany, never deleteMany: the amounts, currency, reference and payment rows
    // are the records being retained for tax and dispute purposes.
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u_1' },
      data: { buyerName: 'Deleted user', buyerEmail: 'deleted+u_1@deleted.invalid' },
    });
    expect(tx.booking).not.toHaveProperty('deleteMany');
  });

  it('keeps tickets valid while removing the attendee identity', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    const call = tx.ticket.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ attendeeUserId: 'u_1' });
    expect(call.data.attendeeUserId).toBeNull();
    expect(call.data.holderName).toBeNull();
    expect(call.data.holderEmail).toBeNull();
    // Deleting an account is not cancelling the tickets it bought — someone may be
    // about to walk through a gate with one.
    expect(call.data).not.toHaveProperty('status');
    expect(call.data).not.toHaveProperty('serial');
  });

  it('anonymises the user row rather than deleting it', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    const data = tx.user.update.mock.calls[0][0].data;
    expect(data.status).toBe('DELETED');
    expect(data.email).toBe('deleted+u_1@deleted.invalid');
    expect(data.fullName).toBe('Deleted user');
    expect(data.roles).toEqual(['CUSTOMER']);
  });

  it('removes the verified phone number', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    const data = tx.user.update.mock.calls[0][0].data;
    expect(data.phone).toBeNull();
    expect(data.phoneVerifiedAt).toBeNull();
  });

  it('leaves a password hash that is valid bcrypt but matches nothing', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    const hash = tx.user.update.mock.calls[0][0].data.passwordHash as string;
    // A sentinel string would make bcrypt.compare throw on a later login attempt,
    // turning a clean rejection into a 500.
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(hash).not.toContain('DELETED');
  });

  it('uses the reserved .invalid TLD so the address can never be routed', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.user.update.mock.calls[0][0].data.email).toMatch(/@deleted\.invalid$/);
  });
});

describe('audit trail', () => {
  it('records the deletion without retaining personal data', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1', { reason: 'PRIVACY' });

    const entry = tx.auditLog.create.mock.calls[0][0].data;
    expect(entry.action).toBe('USER_SELF_DELETED');
    expect(entry.entityId).toBe('u_1');
    // The old email must NOT be here: the audit log outlives the deletion, and a
    // subject-access request would surface it.
    expect(JSON.stringify(entry)).not.toContain('@');
  });

  it('reduces a free-text reason to a known category', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1', { reason: 'your app charged me twice, ref 12345' });

    // Verbatim grievances would be retained in a table that survives the deletion.
    expect(tx.auditLog.create.mock.calls[0][0].data.metadata.reason).toBe('OTHER');
  });

  it('records no reason when none was given', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1');

    expect(tx.auditLog.create.mock.calls[0][0].data.metadata.reason).toBeNull();
  });

  /*
    Replaces 'bounds the user agent'. The row used to keep the caller's IP and a 200-character
    user agent; it now keeps neither, so there is nothing left to bound. An IP beside "this
    account deleted itself" is the identifying link the deletion removes everywhere else.
  */
  it('stores no IP address or user agent', async () => {
    const { service, tx } = makeService();

    await service.deleteMe('u_1', {
      reason: 'PRIVACY',
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (secret-device)',
    } as never);

    const entry = tx.auditLog.create.mock.calls[0][0].data;
    expect(entry).not.toHaveProperty('ip');
    expect(entry.metadata).toEqual({ reason: 'PRIVACY' });
    const text = JSON.stringify(entry);
    expect(text).not.toContain('203.0.113.9');
    expect(text).not.toContain('secret-device');
  });
});

describe('idempotency', () => {
  it('returns success for an already-deleted account instead of an error', async () => {
    const { service, tx } = makeService({
      user: { id: 'u_1', status: 'DELETED', memberships: [] },
    });

    const result = await service.deleteMe('u_1');

    // A client retrying after a dropped response must not be told its deletion failed.
    expect(result).toMatchObject({ status: 'DELETED', alreadyDeleted: true });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('does not re-anonymise or re-audit on a repeat call', async () => {
    const { service, tx } = makeService({
      user: { id: 'u_1', status: 'DELETED', memberships: [] },
    });

    await service.deleteMe('u_1');

    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('404s an unknown user', async () => {
    const { service } = makeService({ user: null });

    await expect(service.deleteMe('nope')).rejects.toBeInstanceOf(AppException);
  });
});

describe('organization owners', () => {
  const soleOwner = {
    id: 'u_1',
    status: 'ACTIVE',
    memberships: [{ organizationId: 'org_1', role: 'ORGANIZER_OWNER', status: 'ACTIVE' }],
  };

  it('refuses when the caller is the only active owner', async () => {
    const { service, tx } = makeService({
      user: soleOwner,
      ownerCounts: [{ organizationId: 'org_1', _count: { _all: 1 } }],
    });

    await expect(service.deleteMe('u_1')).rejects.toBeInstanceOf(AppException);
    // Nothing is touched — a customer-facing action must not half-dismantle a business.
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it('allows deletion when another active owner remains', async () => {
    const { service, tx } = makeService({
      user: soleOwner,
      ownerCounts: [{ organizationId: 'org_1', _count: { _all: 2 } }],
    });

    await service.deleteMe('u_1');

    expect(tx.user.update).toHaveBeenCalled();
  });

  it('allows deletion for a non-owner member', async () => {
    const { service, tx } = makeService({
      user: {
        id: 'u_1',
        status: 'ACTIVE',
        memberships: [{ organizationId: 'org_1', role: 'ORGANIZER_MANAGER', status: 'ACTIVE' }],
      },
    });

    await service.deleteMe('u_1');

    expect(tx.user.update).toHaveBeenCalled();
  });

  it('ignores an inactive owner membership', async () => {
    const { service, tx } = makeService({
      user: {
        id: 'u_1',
        status: 'ACTIVE',
        memberships: [{ organizationId: 'org_1', role: 'ORGANIZER_OWNER', status: 'REMOVED' }],
      },
    });

    await service.deleteMe('u_1');

    expect(tx.user.update).toHaveBeenCalled();
  });

  it('blocks on ANY stranded organization when the user owns several', async () => {
    const { service } = makeService({
      user: {
        id: 'u_1',
        status: 'ACTIVE',
        memberships: [
          { organizationId: 'org_1', role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
          { organizationId: 'org_2', role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
        ],
      },
      // org_1 has a co-owner; org_2 does not.
      ownerCounts: [
        { organizationId: 'org_1', _count: { _all: 2 } },
        { organizationId: 'org_2', _count: { _all: 1 } },
      ],
    });

    await expect(service.deleteMe('u_1')).rejects.toBeInstanceOf(AppException);
  });
});

describe('atomicity', () => {
  it('performs every mutation inside one transaction', async () => {
    const { service, prisma } = makeService();

    await service.deleteMe('u_1');

    // A partial deletion — sessions gone but data intact, or the reverse — is worse
    // than either outcome.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('identity held outside the user row', () => {
  const ANON = 'deleted+u_1@deleted.invalid';
  const verifiedUser = {
    id: 'u_1',
    email: 'Asha@Example.test',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    phone: '+919800000001',
    phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'ACTIVE',
    memberships: [],
  };
  const unverifiedUser = {
    id: 'u_1',
    email: 'asha@example.test',
    emailVerifiedAt: null,
    phone: '+919800000001',
    phoneVerifiedAt: null,
    status: 'ACTIVE',
    memberships: [],
  };

  describe('marketing consent', () => {
    it('anonymises email and phone on the user rows and keeps the rows', async () => {
      const { service, tx } = makeService({ user: unverifiedUser });

      await service.deleteMe('u_1');

      expect(tx.marketingConsent.updateMany).toHaveBeenCalledWith({
        where: { OR: [{ userId: 'u_1' }] },
        data: { email: ANON, phone: null },
      });
      // Evidence: never deleted, and the consent facts are never rewritten.
      expect(tx.marketingConsent).not.toHaveProperty('deleteMany');
      const data = tx.marketingConsent.updateMany.mock.calls[0][0].data;
      for (const kept of [
        'granted',
        'source',
        'createdAt',
        'policyVersion',
        'channel',
        'country',
      ]) {
        expect(data).not.toHaveProperty(kept);
      }
    });

    it('also covers consent given at a guest checkout with the VERIFIED email', async () => {
      const { service, tx } = makeService({ user: verifiedUser });

      await service.deleteMe('u_1');

      expect(tx.marketingConsent.updateMany.mock.calls[0][0].where).toEqual({
        OR: [{ userId: 'u_1' }, { email: 'asha@example.test' }],
      });
    });
  });

  describe('ticket invites', () => {
    it('anonymises invites to the verified email and phone, or accepted by the user', async () => {
      const { service, tx } = makeService({ user: verifiedUser });

      await service.deleteMe('u_1');

      expect(tx.ticketInvite.updateMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { acceptedByUserId: 'u_1' },
            { email: { equals: 'asha@example.test', mode: 'insensitive' } },
            { phone: '+919800000001' },
          ],
        },
        data: { email: null, phone: null },
      });
      expect(tx.ticketInvite).not.toHaveProperty('deleteMany');
    });

    it('matches by address only when the account proved it', async () => {
      const { service, tx } = makeService({ user: unverifiedUser });

      await service.deleteMe('u_1');

      expect(tx.ticketInvite.updateMany.mock.calls[0][0].where).toEqual({
        OR: [{ acceptedByUserId: 'u_1' }],
      });
    });
  });

  describe('feedback', () => {
    it('anonymises the email on the user feedback and keeps the request', async () => {
      const { service, tx } = makeService();

      await service.deleteMe('u_1');

      expect(tx.feedback.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u_1', email: { not: null } },
        data: { email: ANON },
      });
      expect(tx.feedback).not.toHaveProperty('deleteMany');
    });
  });

  describe('guest bookings', () => {
    it('anonymises guest bookings made with the verified email, and their tickets', async () => {
      const { service, tx } = makeService({
        user: verifiedUser,
        guestBookings: [{ id: 'b_g1' }, { id: 'b_g2' }],
      });

      await service.deleteMe('u_1');

      expect(tx.booking.findMany).toHaveBeenCalledWith({
        where: { userId: null, buyerEmail: { equals: 'asha@example.test', mode: 'insensitive' } },
        select: { id: true },
      });
      expect(tx.booking.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['b_g1', 'b_g2'] }, userId: null },
        data: { buyerName: 'Deleted user', buyerEmail: ANON },
      });
      const ticketCall = tx.ticket.updateMany.mock.calls
        .map((c: unknown[]) => c[0] as { where: Record<string, unknown>; data: object })
        .find((c: { where: Record<string, unknown> }) => c.where.bookingId);
      // A ticket somebody else has claimed into their own account is theirs, not this person's.
      expect(ticketCall?.where).toEqual({
        bookingId: { in: ['b_g1', 'b_g2'] },
        attendeeUserId: null,
      });
      expect(ticketCall?.data).toMatchObject({
        holderName: null,
        holderEmail: null,
        attendeePhone: null,
      });
      expect(ticketCall?.data).not.toHaveProperty('status');
      expect(ticketCall?.data).not.toHaveProperty('serial');
    });

    it('does not touch guest bookings when the email was never verified', async () => {
      const { service, tx } = makeService({
        user: unverifiedUser,
        guestBookings: [{ id: 'b_g1' }],
      });

      await service.deleteMe('u_1');

      expect(tx.booking.findMany).not.toHaveBeenCalled();
      // Only the account-owned bookings are anonymised.
      expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.booking.updateMany.mock.calls[0][0].where).toEqual({ userId: 'u_1' });
      expect(tx.ticket.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.ticket.updateMany.mock.calls[0][0].where).toEqual({ attendeeUserId: 'u_1' });
    });

    it('does nothing more when the verified email matches no guest booking', async () => {
      const { service, tx } = makeService({ user: verifiedUser, guestBookings: [] });

      await service.deleteMe('u_1');

      expect(tx.booking.findMany).toHaveBeenCalledTimes(1);
      expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('financial retention', () => {
    const FINANCIAL = [
      'totalMinor',
      'subtotalMinor',
      'amountMinor',
      'currency',
      'status',
      'reference',
      'taxMinor',
      'feeMinor',
      'organizationId',
      'eventId',
      'userId',
    ];

    it('changes only identity fields on bookings, and never deletes a financial row', async () => {
      const { service, tx } = makeService({
        user: verifiedUser,
        guestBookings: [{ id: 'b_g1' }],
      });

      await service.deleteMe('u_1');

      expect(tx.booking.updateMany).toHaveBeenCalledTimes(2);
      for (const [call] of tx.booking.updateMany.mock.calls) {
        expect(Object.keys(call.data).sort()).toEqual(['buyerEmail', 'buyerName']);
        for (const field of FINANCIAL) expect(call.data).not.toHaveProperty(field);
      }
      for (const model of ['booking', 'ticket', 'marketingConsent', 'ticketInvite', 'feedback']) {
        expect((tx as unknown as Record<string, object>)[model]).not.toHaveProperty('deleteMany');
      }
      // No payment, refund, receipt, invoice, payout, settlement or tax model is reachable.
      for (const model of [
        'payment',
        'refund',
        'receipt',
        'invoice',
        'payout',
        'settlement',
        'taxLine',
      ]) {
        expect(tx).not.toHaveProperty(model);
      }
    });

    it('does every new step inside the same single transaction', async () => {
      const { service, prisma, tx } = makeService({
        user: verifiedUser,
        guestBookings: [{ id: 'b_g1' }],
      });

      await service.deleteMe('u_1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.marketingConsent.updateMany).toHaveBeenCalled();
      expect(tx.ticketInvite.updateMany).toHaveBeenCalled();
      expect(tx.feedback.updateMany).toHaveBeenCalled();
      expect(prisma).not.toHaveProperty('marketingConsent');
      expect(prisma).not.toHaveProperty('booking');
    });
  });
});
