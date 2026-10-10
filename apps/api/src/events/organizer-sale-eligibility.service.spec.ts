import { Role } from '@eticketsgo/shared-types';
import {
  OrganizerSaleEligibilityService,
  SALE_ELIGIBILITY_MAX_SESSIONS,
} from './organizer-sale-eligibility.service';
import type { RequestUser } from '../common/decorators';

/**
 * The Overview's "is this show selling" read. What it must get right is scope and fidelity:
 * only the organization's own shows are answered, each by `SaleEligibilityService.forSession`
 * itself (the function checkout refuses a cart by), and "open" means exactly what the
 * storefront's `onlineBooking.open` means. The eligibility rules are not re-tested here; they
 * have their own spec and are deliberately not re-implemented.
 */
describe('OrganizerSaleEligibilityService', () => {
  const user = { id: 'u1', roles: [Role.ORGANIZER_OWNER] } as unknown as RequestUser;

  function build(owned: string[], verdicts: Record<string, unknown>) {
    const prisma = {
      eventSession: {
        findMany: jest.fn().mockResolvedValue(owned.map((id) => ({ id }))),
      },
    };
    const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
    const eligibility = {
      forSession: jest.fn((id: string) => Promise.resolve(verdicts[id])),
    };
    const svc = new OrganizerSaleEligibilityService(
      prisma as never,
      access as never,
      eligibility as never,
    );
    return { svc, prisma, access, eligibility };
  }

  const telangana = {
    sellable: false,
    sellableTicketTypeIds: [],
    blockers: [
      {
        code: 'NO_PRICING_POLICY',
        owner: 'PLATFORM',
        organizerMessage: 'Ticket sales are paused for cinemas in Telangana.',
        buyerMessage: 'Online booking is not open for this show yet.',
        fixPath: null,
        ticketTypeIds: ['t1'],
      },
    ],
  };

  it('checks membership with the calendar roles before reading anything', async () => {
    const { svc, access } = build([], {});
    await svc.forSessions(user, 'org1', ['s1']);
    expect(access.assertMember).toHaveBeenCalledWith(user, 'org1', [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
  });

  it('answers only the shows that belong to the organization', async () => {
    const { svc, prisma, eligibility } = build(['mine'], {
      mine: { sellable: true, sellableTicketTypeIds: ['t1'], blockers: [] },
    });
    const out = await svc.forSessions(user, 'org1', ['mine', 'theirs']);
    expect(prisma.eventSession.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['mine', 'theirs'] }, event: { organizationId: 'org1' } },
      select: { id: true },
    });
    expect(eligibility.forSession).toHaveBeenCalledTimes(1);
    expect(out.sessions.map((s) => s.sessionId)).toEqual(['mine']);
  });

  it('says a show checkout refuses is not open, with the organizer sentence and no buyer copy', async () => {
    const { svc } = build(['s1'], { s1: telangana });
    const [s] = (await svc.forSessions(user, 'org1', ['s1'])).sessions;
    expect(s.open).toBe(false);
    expect(s.sellable).toBe(false);
    expect(s.blockers).toEqual([
      {
        code: 'NO_PRICING_POLICY',
        owner: 'PLATFORM',
        message: 'Ticket sales are paused for cinemas in Telangana.',
        fixPath: null,
      },
    ]);
  });

  it('calls a show open when some of its ticket types sell, as the storefront does', async () => {
    const { svc } = build(['s1'], { s1: { ...telangana, sellableTicketTypeIds: ['t2'] } });
    const [s] = (await svc.forSessions(user, 'org1', ['s1'])).sessions;
    expect(s.open).toBe(true);
    expect(s.sellable).toBe(false);
  });

  it('refuses more than the cap and asks nothing for an empty list', async () => {
    const { svc, prisma } = build([], {});
    const many = Array.from({ length: SALE_ELIGIBILITY_MAX_SESSIONS + 1 }, (_, i) => `s${i}`);
    await expect(svc.forSessions(user, 'org1', many)).rejects.toThrow(/at most/);
    await expect(svc.forSessions(user, 'org1', [])).resolves.toEqual({ sessions: [] });
    expect(prisma.eventSession.findMany).not.toHaveBeenCalled();
  });
});
