import { CinemasService } from './cinemas.service';

/**
 * A cinema can only be pointed at its own organization's venue.
 *
 * `create` already refused a foreign venue; `update` wrote `venueId` straight from the patch,
 * so a tenant could re-home its cinema — and every show later scheduled in it — onto another
 * tenant's venue record just by naming its id.
 */
const OPERATOR = { id: 'u-owner', email: 'o@x.test', fullName: 'O', roles: [] } as never;

function setup(venue: { organizationId: string } | null) {
  const prisma = {
    cinema: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'cin-1',
        organizationId: 'org-a',
        venueId: 'ven-a',
        timezone: 'Asia/Kolkata',
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'cin-1',
        ...data,
        screens: [],
      })),
    },
    venue: { findUnique: jest.fn().mockResolvedValue(venue) },
    eventSession: { count: jest.fn().mockResolvedValue(0) },
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  return { svc: new CinemasService(prisma as never, access as never), prisma };
}

describe('CinemasService.update — the venue must belong to the cinema’s organization', () => {
  it('refuses another organization’s venue, and writes nothing', async () => {
    const { svc, prisma } = setup({ organizationId: 'org-b' });
    await expect(svc.update(OPERATOR, 'cin-1', { venueId: 'ven-b' })).rejects.toThrow(
      /venue not found for this organization/i,
    );
    expect(prisma.cinema.update).not.toHaveBeenCalled();
  });

  it('answers a venue id that does not exist identically, so it confirms nothing', async () => {
    const { svc, prisma } = setup(null);
    await expect(svc.update(OPERATOR, 'cin-1', { venueId: 'ven-missing' })).rejects.toThrow(
      /venue not found for this organization/i,
    );
    expect(prisma.cinema.update).not.toHaveBeenCalled();
  });

  it('accepts a venue of the same organization', async () => {
    const { svc, prisma } = setup({ organizationId: 'org-a' });
    await svc.update(OPERATOR, 'cin-1', { venueId: 'ven-a2' });
    expect(prisma.cinema.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { venueId: 'ven-a2' } }),
    );
  });

  it('does not look a venue up when the patch does not change it', async () => {
    const { svc, prisma } = setup(null);
    await svc.update(OPERATOR, 'cin-1', { name: 'Renamed' });
    expect(prisma.venue.findUnique).not.toHaveBeenCalled();
    expect(prisma.cinema.update).toHaveBeenCalled();
  });
});
