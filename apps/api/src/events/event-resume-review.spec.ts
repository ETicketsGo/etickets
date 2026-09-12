import { EventStatus, NotificationType, OrganizationStatus } from '@eticketsgo/shared-types';
import { EventsService } from './events.service';
import { EventImageService } from './event-image.service';

/**
 * Pause, edit, resume — without skipping the platform.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
 * A published event could be paused, its title, description, category and venue rewritten,
 * and resumed straight back to PUBLISHED: content no reviewer had seen, on sale. And an event
 * an admin paused could be resumed by its organizer with the same button they use for their
 * own pauses, undoing a moderation decision in one click.
 *
 * The decision: edits to reviewed details made while paused send the event to review on
 * resume, unless the organizer is trusted to auto-publish; images change without review; and
 * a pause by the platform team is lifted only by the platform team.
 */
const ORGANIZER = { id: 'u-org', email: 'o@t.test', fullName: 'O', roles: [] } as never;
const ADMIN = { id: 'u-admin', email: 'a@t.test', fullName: 'A', roles: ['ADMIN'] } as never;

function setup(
  over: {
    status?: string;
    needsReviewOnResume?: boolean;
    pausedByAdminAt?: Date | null;
    autoApproveEvents?: boolean;
    orgStatus?: string;
  } = {},
) {
  const event = {
    id: 'ev-1',
    organizationId: 'org-1',
    venueId: 'ven-1',
    status: over.status ?? EventStatus.PAUSED,
    title: 'Hamlet',
    category: 'Theatre',
    description: null,
    feeMode: 'CUSTOMER_PAYS',
    isFree: false,
    refundPolicy: null,
    refundsEnabled: true,
    refundCutoffHours: 48,
    publishedAt: new Date('2026-08-01T10:00:00Z'),
    needsReviewOnResume: over.needsReviewOnResume ?? false,
    pausedByAdminAt: over.pausedByAdminAt ?? null,
  };
  const eventUpdate = jest.fn().mockImplementation(async ({ data }) => ({ ...event, ...data }));
  const record = jest.fn().mockResolvedValue(undefined);
  const notifyAdmins = jest.fn().mockResolvedValue(undefined);
  const notifyOrganizationOwners = jest.fn().mockResolvedValue(undefined);
  const organizationFind = jest.fn().mockResolvedValue({
    name: 'Globe Theatre Co',
    status: over.orgStatus ?? OrganizationStatus.APPROVED,
    autoApproveEvents: over.autoApproveEvents ?? false,
  });

  const prisma = {
    event: {
      findUnique: jest.fn().mockResolvedValue({ ...event, images: [] }),
      update: eventUpdate,
    },
    organization: { findUnique: organizationFind },
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'ven-2', organizationId: 'org-1' }) },
    booking: { count: jest.fn().mockResolvedValue(0) },
    eventSession: { count: jest.fn().mockResolvedValue(1) },
    ticketType: { count: jest.fn().mockResolvedValue(1) },
  };
  const service = new EventsService(
    prisma as never,
    { assertMember: async () => undefined } as never,
    { record } as never,
    { notifyAdmins, notifyOrganizationOwners } as never,
    { get: () => 'http://localhost:3000' } as never,
    // Seating a session is delegated to ShowsService; nothing here uses a room.
    {} as never,
    // Publishing consults sellability; these cases are about who reviews, so nothing blocks.
    { check: async () => ({ sellable: true, blockers: [], warnings: [] }) } as never,
  );
  return { service, prisma, eventUpdate, record, notifyAdmins, organizationFind };
}

describe('editing a paused event', () => {
  it.each([
    ['title', { title: 'Hamlet (revised)' }],
    ['description', { description: 'Now with a different ending.' }],
    ['category', { category: 'Comedy' }],
    ['venue', { venueId: 'ven-2' }],
    ['fee handling', { feeMode: 'ORGANIZER_PAYS' as never }],
    ['refund policy', { refundPolicy: 'No refunds.' }],
    ['refund switch', { refundsEnabled: false }],
    ['refund cut-off', { refundCutoffHours: 2 }],
  ])('marks it for review on resume when the %s changes', async (_name, patch) => {
    const { service, eventUpdate, record } = setup();
    await service.update(ORGANIZER, 'ev-1', patch);

    expect(eventUpdate.mock.calls[0][0].data).toEqual({ ...patch, needsReviewOnResume: true });
    // Named, so the reviewer who picks it up knows what to look at.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'EVENT_EDITED_WHILE_PAUSED',
        metadata: { fields: Object.keys(patch) },
      }),
    );
  });

  it('does not mark it for a Save that changes nothing', async () => {
    /*
      The edit form sends every field on every save, and an empty description box as nothing
      at all. Counting presence as change would send an event to review for pressing Save.
    */
    const { service, eventUpdate, record } = setup();
    await service.update(ORGANIZER, 'ev-1', {
      title: 'Hamlet',
      category: 'Theatre',
      description: '',
      feeMode: 'CUSTOMER_PAYS' as never,
      isFree: false,
    });

    expect(eventUpdate.mock.calls[0][0].data.needsReviewOnResume).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('does not mark a draft, which goes through review when it is submitted anyway', async () => {
    const { service, eventUpdate } = setup({ status: EventStatus.DRAFT });
    await service.update(ORGANIZER, 'ev-1', { title: 'Hamlet (revised)' });
    expect(eventUpdate).toHaveBeenCalledWith({
      where: { id: 'ev-1' },
      data: { title: 'Hamlet (revised)' },
    });
  });

  it('an image change does not mark it — the owner decided pictures change without review', async () => {
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const eventImage = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'img-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = {
      event: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'ev-1', organizationId: 'org-1', status: EventStatus.PAUSED }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      eventImage,
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({ eventImage })),
    };
    const images = new EventImageService(
      prisma as never,
      { assertMember: async () => undefined } as never,
      { record: async () => undefined } as never,
    );

    await images.add(ORGANIZER, 'ev-1', { buffer: PNG, size: PNG.length });
    await images.remove(ORGANIZER, 'ev-1', 'img-1');

    expect(eventImage.create).toHaveBeenCalled();
    expect(prisma.event.update).not.toHaveBeenCalled();
    expect(prisma.event.updateMany).not.toHaveBeenCalled();
  });
});

describe('resuming a paused event', () => {
  it('goes straight back on sale when nothing reviewed was edited', async () => {
    const { service, eventUpdate, notifyAdmins, organizationFind } = setup();
    const result = await service.setPaused(ORGANIZER, 'ev-1', false);

    expect(result.status).toBe(EventStatus.PUBLISHED);
    expect(result).toMatchObject({ sentForReview: false });
    expect(eventUpdate.mock.calls[0][0].data.status).toBe(EventStatus.PUBLISHED);
    expect(organizationFind).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('sends an edited event to review instead, for an organizer who is not trusted', async () => {
    const { service, eventUpdate, notifyAdmins, record } = setup({ needsReviewOnResume: true });
    const result = await service.setPaused(ORGANIZER, 'ev-1', false);

    expect(result.status).toBe(EventStatus.UNDER_REVIEW);
    // Said outright, so the console can tell the organizer why it is not live.
    expect(result).toMatchObject({ sentForReview: true });
    expect(eventUpdate.mock.calls[0][0].data).toEqual({
      status: EventStatus.UNDER_REVIEW,
      needsReviewOnResume: false,
    });
    // Paged the way a submission is: it cannot sell until somebody looks.
    expect(notifyAdmins).toHaveBeenCalledWith(
      NotificationType.EVENT_SUBMITTED,
      expect.objectContaining({ eventId: 'ev-1', organizationName: 'Globe Theatre Co' }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'EVENT_RESUME_SENT_FOR_REVIEW',
        metadata: { reason: 'EDITED_WHILE_PAUSED' },
      }),
    );
  });

  it('publishes an edited event for a trusted organizer, as submitting would', async () => {
    const { service, eventUpdate, notifyAdmins, record } = setup({
      needsReviewOnResume: true,
      autoApproveEvents: true,
    });
    const result = await service.setPaused(ORGANIZER, 'ev-1', false);

    expect(result.status).toBe(EventStatus.PUBLISHED);
    expect(result).toMatchObject({ sentForReview: false });
    expect(eventUpdate.mock.calls[0][0].data).toEqual({
      status: EventStatus.PUBLISHED,
      needsReviewOnResume: false,
    });
    expect(notifyAdmins).not.toHaveBeenCalled();
    // Findable under the same term as any other content that went live unreviewed.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'EVENT_AUTO_APPROVED',
        metadata: { via: 'RESUME_AFTER_EDIT' },
      }),
    );
  });

  it('a suspended organizer is not trusted, whatever its flag says', async () => {
    const { service } = setup({
      needsReviewOnResume: true,
      autoApproveEvents: true,
      orgStatus: OrganizationStatus.SUSPENDED,
    });
    const result = await service.setPaused(ORGANIZER, 'ev-1', false);
    expect(result.status).toBe(EventStatus.UNDER_REVIEW);
  });

  it('writes only if the event is still as it was read, and says so when it is not', async () => {
    // An admin pause or an edit landing between the read and the write must not be overwritten.
    const { service, eventUpdate } = setup({ needsReviewOnResume: true });
    eventUpdate.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'P2025' }));

    await expect(service.setPaused(ORGANIZER, 'ev-1', false)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(eventUpdate.mock.calls[0][0].where).toEqual({
      id: 'ev-1',
      status: EventStatus.PAUSED,
      pausedByAdminAt: null,
      needsReviewOnResume: true,
    });
  });
});

describe('an event paused by the platform team', () => {
  const pausedByAdminAt = new Date('2026-09-10T08:00:00Z');

  it('cannot be resumed by its organizer', async () => {
    const { service, eventUpdate } = setup({ pausedByAdminAt });
    const failure = await service.setPaused(ORGANIZER, 'ev-1', false).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'FORBIDDEN' });
    expect((failure as { getStatus(): number }).getStatus()).toBe(403);
    expect((failure as Error).message).toBe(
      'This event was paused by the platform team. Contact support to resume it.',
    );
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it('cannot be put back on sale by submitting it either', async () => {
    // For a trusted organizer, submitting a paused event publishes it — Resume by another name.
    const { service, eventUpdate } = setup({ pausedByAdminAt, autoApproveEvents: true });
    await expect(service.submitForReview(ORGANIZER, 'ev-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it('is marked when an admin pauses it, and never when the organizer does', async () => {
    const admin = setup({ status: EventStatus.PUBLISHED });
    await admin.service.adminSetStatus(ADMIN, 'ev-1', EventStatus.PAUSED);
    expect(admin.eventUpdate.mock.calls[0][0].data.pausedByAdminAt).toBeInstanceOf(Date);

    const organizer = setup({ status: EventStatus.PUBLISHED });
    await organizer.service.setPaused(ORGANIZER, 'ev-1', true);
    expect(organizer.eventUpdate.mock.calls[0][0].data).toEqual({ status: EventStatus.PAUSED });
  });

  it('is cleared when an admin resumes it, with any pending review settled by that decision', async () => {
    const { service, eventUpdate } = setup({ pausedByAdminAt, needsReviewOnResume: true });
    await service.adminSetStatus(ADMIN, 'ev-1', EventStatus.PUBLISHED);

    expect(eventUpdate.mock.calls[0][0].data).toEqual({
      status: EventStatus.PUBLISHED,
      pausedByAdminAt: null,
      needsReviewOnResume: false,
    });
  });

  it('is shown to the organizer console, so it can say why there is no Resume button', async () => {
    const { service } = setup({ pausedByAdminAt });
    const detail = await service.getForOrg(ORGANIZER, 'ev-1');
    expect(detail).toMatchObject({ pausedByAdmin: true });

    const own = await setup().service.getForOrg(ORGANIZER, 'ev-1');
    expect(own).toMatchObject({ pausedByAdmin: false });
  });
});
