import { EventStatus, NotificationType, OrganizationStatus } from '@eticketsgo/shared-types';
import { EventsService } from './events.service';
import { OrganizationsService } from '../organizations/organizations.service';

/**
 * Letting a trusted organizer publish without waiting for a reviewer.
 *
 * ── WHAT WAS ASKED FOR ─────────────────────────────────────────────────────────────
 * "It is hard to approve each and every event — let's have a toggle on the orgs, auto
 * approve if we are getting an event from trusted orgs. We disable auto approve for new orgs
 * or not trusted ones."
 *
 * Review exists for a real reason: a new organizer can list a venue they do not have at a
 * price that is a typo, and by the time anyone notices somebody has paid. That cost is worth
 * paying once. Paying it on the two-hundredth event from a cinema chain that has never had
 * one rejected is a delay and nothing else.
 *
 * The whole feature therefore lives or dies on who can turn it on, and on what "trusted"
 * means. These tests are mostly about that.
 */
const ORGANIZER = { id: 'u-org', email: 'o@t.test', fullName: 'O', roles: [] } as never;
const ADMIN = { id: 'u-admin', email: 'a@t.test', fullName: 'A', roles: ['ADMIN'] } as never;

function submitSetup(over: { autoApproveEvents?: boolean; orgStatus?: string } = {}) {
  const event = {
    id: 'ev-1',
    organizationId: 'org-1',
    status: EventStatus.DRAFT,
    title: 'Season Opener',
  };
  const eventUpdate = jest
    .fn()
    .mockImplementation(async ({ data }) => ({ ...event, ...data, title: event.title }));
  const notifyAdmins = jest.fn().mockResolvedValue(undefined);
  const notifyOrganizationOwners = jest.fn().mockResolvedValue(undefined);
  const record = jest.fn().mockResolvedValue(undefined);

  const prisma = {
    event: { findUnique: jest.fn().mockResolvedValue(event), update: eventUpdate },
    eventSession: { count: jest.fn().mockResolvedValue(1) },
    ticketType: { count: jest.fn().mockResolvedValue(1) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'PVR Cinemas',
        status: over.orgStatus ?? OrganizationStatus.APPROVED,
        autoApproveEvents: over.autoApproveEvents ?? false,
      }),
    },
  };

  const service = new EventsService(
    prisma as never,
    { assertMember: async () => undefined } as never,
    { record } as never,
    { notifyAdmins, notifyOrganizationOwners } as never,
    { get: () => 'http://localhost:3000' } as never,
    // Seating a session is delegated to ShowsService; none of these cases uses a room.
    {} as never,
  );
  return { service, eventUpdate, notifyAdmins, notifyOrganizationOwners, record };
}

describe('submitting an event from a trusted organizer', () => {
  it('publishes it immediately instead of queueing it', async () => {
    const { service, eventUpdate } = submitSetup({ autoApproveEvents: true });
    const result = await service.submitForReview(ORGANIZER, 'ev-1');

    expect(result.status).toBe(EventStatus.PUBLISHED);
    expect(eventUpdate.mock.calls[0][0].data.publishedAt).toBeInstanceOf(Date);
  });

  it('does not page the reviewers about an event nobody has to review', async () => {
    // The point of the feature. A queue notification for something already live is noise,
    // and noise is what makes a real queue get ignored.
    const { service, notifyAdmins, notifyOrganizationOwners } = submitSetup({
      autoApproveEvents: true,
    });
    await service.submitForReview(ORGANIZER, 'ev-1');

    expect(notifyAdmins).not.toHaveBeenCalled();
    // The organizer still hears that it is live, in the same words a reviewer's approval uses.
    expect(notifyOrganizationOwners).toHaveBeenCalledWith(
      'org-1',
      NotificationType.EVENT_APPROVED,
      expect.objectContaining({ eventId: 'ev-1' }),
    );
  });

  it('records it under its own audit action, not as an ordinary approval', async () => {
    /*
      An admin asking "what went live without a human looking at it?" needs one term to
      search for. Logging it as EVENT_APPROVED would hide exactly the events most worth
      being able to find.
    */
    const { service, record } = submitSetup({ autoApproveEvents: true });
    await service.submitForReview(ORGANIZER, 'ev-1');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'EVENT_AUTO_APPROVED' }));
  });

  it('a suspended organizer never auto-publishes, whatever the flag says', async () => {
    /*
      Suspension is the platform withdrawing trust right now. A flag set last month must not
      outrank it — otherwise suspending an organizer would leave the one route that matters
      wide open.
    */
    const { service, eventUpdate, notifyAdmins } = submitSetup({
      autoApproveEvents: true,
      orgStatus: OrganizationStatus.SUSPENDED,
    });
    const result = await service.submitForReview(ORGANIZER, 'ev-1');

    expect(result.status).toBe(EventStatus.UNDER_REVIEW);
    expect(eventUpdate.mock.calls[0][0].data.publishedAt).toBeUndefined();
    expect(notifyAdmins).toHaveBeenCalled();
  });

  it('an untrusted organizer still goes through review, exactly as before', async () => {
    const { service, notifyAdmins, record } = submitSetup({ autoApproveEvents: false });
    const result = await service.submitForReview(ORGANIZER, 'ev-1');

    expect(result.status).toBe(EventStatus.UNDER_REVIEW);
    expect(notifyAdmins).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EVENT_SUBMITTED_FOR_REVIEW' }),
    );
  });
});

function trustSetup(over: { status?: string; approvedEvents?: number } = {}) {
  const org = {
    id: 'org-1',
    status: over.status ?? OrganizationStatus.APPROVED,
    autoApproveEvents: false,
  };
  const update = jest
    .fn()
    .mockImplementation(async ({ data }) => ({ ...org, ...data, id: 'org-1' }));
  const record = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue(org), update },
    event: { count: jest.fn().mockResolvedValue(over.approvedEvents ?? 5) },
  };
  const service = new OrganizationsService(
    prisma as never,
    { assertMember: async () => undefined, isPlatformAdmin: () => true } as never,
    { record } as never,
    { notifyAdmins: jest.fn(), notifyOrganizationOwners: jest.fn() } as never,
  );
  return { service, update, record, prisma };
}

describe('granting an organizer the right to skip review', () => {
  it('turns it on for an approved organizer with a track record', async () => {
    const { service, update, record } = trustSetup();
    const result = await service.setAutoApprove(ADMIN, 'org-1', true);

    expect(result.autoApproveEvents).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoApproveEvents: true } }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORG_AUTO_APPROVE_ENABLED' }),
    );
  });

  it('refuses a brand-new organizer — the "not for new orgs" half of the ask', async () => {
    /*
      Enforced rather than left to whoever is clicking. "Trusted" has to mean an actual
      history of events that a human looked at and approved; without this the flag is just a
      checkbox somebody can tick on the organizer's first day.
    */
    const { service, update } = trustSetup({ approvedEvents: 0 });
    await expect(service.setAutoApprove(ADMIN, 'org-1', true)).rejects.toThrow(
      /never had an event approved/i,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an organizer who is not approved themselves', async () => {
    const { service, update } = trustSetup({ status: OrganizationStatus.PENDING });
    await expect(service.setAutoApprove(ADMIN, 'org-1', true)).rejects.toThrow(
      /Only an approved organizer/i,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('turning it OFF has no conditions at all', async () => {
    /*
      Withdrawing trust must never be harder than granting it. A suspended organizer with a
      stale flag is precisely the case where somebody needs this to work immediately.
    */
    const { service, update, record } = trustSetup({
      status: OrganizationStatus.SUSPENDED,
      approvedEvents: 0,
    });
    const result = await service.setAutoApprove(ADMIN, 'org-1', false);

    expect(result.autoApproveEvents).toBe(false);
    expect(update).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORG_AUTO_APPROVE_DISABLED' }),
    );
  });
});
