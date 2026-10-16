import { CinemasService } from './cinemas.service';
import {
  CINEMA_LEGAL_TYPE_CHANGED,
  CinemaLegalTypeService,
  legalTypeWords,
} from './cinema-legal-type.service';

/**
 * A cinema's legal type (local body, format, cooling) is the platform's to set.
 *
 * It picks the row of a state rate order the cinema's tickets are checked against - the most a
 * ticket may cost. The organizer API used to take it from any organizer, so an exhibitor could
 * choose its own price limit with one request. Now the organizer paths refuse it out loud, and
 * the only writer is the admin service, which records who changed it, from what, and why in the
 * same transaction as the change.
 */
const OPERATOR = { id: 'u-owner', email: 'o@x.test', fullName: 'O', roles: [] } as never;

describe('organizers cannot set their own legal type', () => {
  const build = () => {
    const prisma = {
      cinema: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: 'cin-1', organizationId: 'org-a' }),
      },
      venue: { create: jest.fn(), findUnique: jest.fn() },
      eventSession: { count: jest.fn().mockResolvedValue(0) },
    };
    const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
    return { prisma, service: new CinemasService(prisma as never, access as never) };
  };

  it.each([
    ['localBodyType', 'MUNICIPAL_CORPORATION'],
    ['cinemaFormat', 'MULTIPLEX'],
    ['climateType', 'AC'],
  ] as const)('refuses %s on update, and writes nothing', async (field, value) => {
    const { prisma, service } = build();
    await expect(service.update(OPERATOR, 'cin-1', { [field]: value })).rejects.toMatchObject({
      response: expect.objectContaining({
        details: expect.objectContaining({ reason: 'LEGAL_TYPE_SET_BY_PLATFORM', fields: [field] }),
      }),
    });
    expect(prisma.cinema.update).not.toHaveBeenCalled();
  });

  it('refuses it on create, before any venue or cinema is written', async () => {
    const { prisma, service } = build();
    await expect(
      service.create(OPERATOR, 'org-a', {
        name: 'Picked My Own Slab',
        city: 'Vijayawada',
        country: 'India',
        region: 'Andhra Pradesh',
        timezone: 'Asia/Kolkata',
        localBodyType: 'GRAM_PANCHAYAT',
      }),
    ).rejects.toThrow(/only ETicketsGo can set it/);
    expect(prisma.venue.create).not.toHaveBeenCalled();
    expect(prisma.cinema.create).not.toHaveBeenCalled();
  });

  it('still saves an ordinary edit that does not touch the legal type', async () => {
    const { prisma, service } = build();
    prisma.cinema.update.mockResolvedValue({ id: 'cin-1' });
    await service.update(OPERATOR, 'cin-1', { name: 'Renamed' });
    expect(prisma.cinema.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Renamed' } }),
    );
  });
});

describe('CinemaLegalTypeService.set - the platform team sets it, with a record', () => {
  const stored = {
    id: 'cin-1',
    name: 'Vijayawada Multiplex',
    city: 'Vijayawada',
    country: null,
    region: null,
    localBodyType: null,
    cinemaFormat: 'MULTIPLEX',
    climateType: null,
    updatedAt: new Date('2026-10-16T00:00:00Z'),
    organization: { id: 'org-a', name: 'Bengaluru Live' },
    venue: {
      id: 'v1',
      name: 'Vijayawada Multiplex',
      city: 'Vijayawada',
      region: 'Andhra Pradesh',
      country: 'India',
    },
  };

  const build = (opts: { auditFails?: boolean; missing?: boolean } = {}) => {
    const writes: string[] = [];
    const tx = {
      cinema: {
        findUnique: jest.fn().mockResolvedValue(opts.missing ? null : stored),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.push('cinema');
          return { ...stored, ...data };
        }),
      },
      auditLog: {
        create: jest.fn(async () => {
          if (opts.auditFails) throw new Error('audit table unavailable');
          writes.push('audit');
        }),
      },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { tx, prisma, writes, service: new CinemaLegalTypeService(prisma as never) };
  };

  const input = {
    localBodyType: 'MUNICIPAL_CORPORATION' as const,
    cinemaFormat: 'MULTIPLEX' as const,
    climateType: 'AC' as const,
    reason: 'Licence copy received from the exhibitor.',
  };

  it('writes the change and its audit entry in one transaction', async () => {
    const { tx, prisma, writes, service } = build();
    const row = await service.set('admin-1', 'cin-1', input);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(['cinema', 'audit']);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'admin-1',
        organizationId: 'org-a',
        action: CINEMA_LEGAL_TYPE_CHANGED,
        entityType: 'Cinema',
        entityId: 'cin-1',
        metadata: expect.objectContaining({
          before: { localBodyType: null, cinemaFormat: 'MULTIPLEX', climateType: null },
          after: {
            localBodyType: 'MUNICIPAL_CORPORATION',
            cinemaFormat: 'MULTIPLEX',
            climateType: 'AC',
          },
          change:
            'not set, Multiplex, not set -> Municipal corporation, Multiplex, Air-conditioned',
          reason: input.reason,
        }),
      }),
    });
    // Where it is comes from the venue, the place record.
    expect(row).toMatchObject({ region: 'Andhra Pradesh', country: 'India', climateType: 'AC' });
  });

  it('does not keep a change it could not record', async () => {
    // The transaction rejects, so the update inside it is rolled back by the database.
    const { service } = build({ auditFails: true });
    await expect(service.set('admin-1', 'cin-1', input)).rejects.toThrow(/audit/);
  });

  it('answers 404 for a cinema that does not exist, and writes nothing', async () => {
    const { tx, service } = build({ missing: true });
    await expect(service.set('admin-1', 'nope', input)).rejects.toThrow(/Cinema not found/);
    expect(tx.cinema.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('words a legal type for a person', () => {
    expect(
      legalTypeWords({
        localBodyType: 'GRAM_PANCHAYAT',
        cinemaFormat: null,
        climateType: 'NON_AC',
      }),
    ).toBe('Gram panchayat, not set, Not air-conditioned');
  });
});
