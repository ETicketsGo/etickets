import { Prisma } from '@prisma/client';
import { EventStatus } from '@eticketsgo/shared-types';
import { EventsService } from './events.service';

/**
 * The details a buyer checks before paying: the age limit, the organizer's terms, and who is
 * performing.
 *
 * Asked for by the owner alongside a BookMyShow event page. These pin what the API stores for
 * each, how "cleared" is stored, and that changing one on a paused live event sends it back
 * through review - the same rule every other reviewed detail follows.
 */
const ORGANIZER = { id: 'u-org', email: 'o@t.test', fullName: 'O', roles: [] } as never;

const ARTISTS = [
  { name: 'Venkat Blaze', role: 'Performer', bio: 'Telugu stand-up.' },
  { name: 'Aromale Cafe', role: 'Host' },
];

function setup(stored: Record<string, unknown> = {}) {
  const event = {
    id: 'ev-1',
    organizationId: 'org-1',
    venueId: 'ven-1',
    status: EventStatus.PAUSED,
    title: 'Ilakathamafiliya',
    category: 'Comedy',
    description: null,
    feeMode: 'CUSTOMER_PAYS',
    isFree: false,
    refundPolicy: null,
    refundsEnabled: true,
    refundCutoffHours: 48,
    ageLimit: null,
    termsAndConditions: null,
    artists: null,
    publishedAt: new Date('2026-09-01T10:00:00Z'),
    needsReviewOnResume: false,
    pausedByAdminAt: null,
    ...stored,
  };
  const update = jest.fn().mockImplementation(async ({ data }) => ({ ...event, ...data }));
  const create = jest.fn().mockImplementation(async ({ data }) => ({ id: 'new', ...data }));
  const prisma = {
    event: { findUnique: jest.fn().mockResolvedValue({ ...event, images: [] }), update, create },
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'ven-1', organizationId: 'org-1' }) },
    booking: { count: jest.fn().mockResolvedValue(0) },
    ticketType: { count: jest.fn().mockResolvedValue(0) },
  };
  const service = new EventsService(
    prisma as never,
    { assertMember: async () => undefined } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { notifyAdmins: jest.fn(), notifyOrganizationOwners: jest.fn() } as never,
    { get: () => 'http://localhost:3000' } as never,
    {} as never,
    { check: async () => ({ sellable: true, blockers: [], warnings: [] }) } as never,
  );
  return { service, update, create };
}

describe('event details: age limit, terms, artists', () => {
  it('stores all three when an event is created', async () => {
    const { service, create } = setup();
    await service.create(ORGANIZER, 'org-1', {
      title: 'Ilakathamafiliya',
      category: 'Comedy',
      venueId: 'ven-1',
      feeMode: 'CUSTOMER_PAYS' as never,
      isFree: false,
      ageLimit: 16,
      termsAndConditions: 'Tickets cannot be exchanged.\nArrive 30 minutes early.',
      artists: ARTISTS,
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      ageLimit: 16,
      termsAndConditions: 'Tickets cannot be exchanged.\nArrive 30 minutes early.',
      artists: ARTISTS,
    });
  });

  it('leaves them alone when an edit does not mention them', async () => {
    const { service, update } = setup({
      status: EventStatus.DRAFT,
      ageLimit: 18,
      artists: ARTISTS,
    });
    await service.update(ORGANIZER, 'ev-1', { title: 'Renamed' });
    const data = update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('ageLimit');
    expect(data).not.toHaveProperty('artists');
    expect(data).not.toHaveProperty('termsAndConditions');
  });

  it('stores "cleared" as nothing, whatever shape it arrives in', async () => {
    const { service, update } = setup({
      status: EventStatus.DRAFT,
      ageLimit: 18,
      artists: ARTISTS,
    });
    await service.update(ORGANIZER, 'ev-1', {
      ageLimit: null,
      termsAndConditions: '   ',
      artists: [],
    });
    const data = update.mock.calls[0][0].data;
    expect(data.ageLimit).toBeNull();
    expect(data.termsAndConditions).toBeNull();
    // A JSON column is cleared with DbNull; a plain null is refused by Prisma.
    expect(data.artists).toBe(Prisma.DbNull);
  });

  describe('on a paused live event, they are reviewed details', () => {
    it.each([
      ['raising the age limit', { ageLimit: 18 }],
      ['adding terms', { termsAndConditions: 'No re-entry.' }],
      ['changing the line-up', { artists: [{ name: 'Someone else' }] }],
    ])('%s sends the event back to review', async (_name, patch) => {
      const { service, update } = setup({ ageLimit: 16, artists: ARTISTS });
      await service.update(ORGANIZER, 'ev-1', patch as never);
      expect(update.mock.calls[0][0].data.needsReviewOnResume).toBe(true);
    });

    it('saving the same line-up again is not a change', async () => {
      // Two arrays are never ===; compared by content, a Save that changed nothing costs nothing.
      const { service, update } = setup({ artists: ARTISTS });
      await service.update(ORGANIZER, 'ev-1', { artists: ARTISTS.map((a) => ({ ...a })) });
      expect(update.mock.calls[0][0].data.needsReviewOnResume).toBeUndefined();
    });
  });
});
