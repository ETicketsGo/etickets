import { Role } from '@eticketsgo/shared-types';
import {
  OrganizerSaleEligibilityService,
  SALE_ELIGIBILITY_MAX_EVENTS,
  SALE_ELIGIBILITY_MAX_SESSIONS,
} from './organizer-sale-eligibility.service';
import type { RequestUser } from '../common/decorators';

/**
 * The Overview's "is this show selling" read, and its per-event sibling. What they must get
 * right is scope and fidelity: only the organization's own shows and events are answered, each
 * by `SaleEligibilityService` (built on the function checkout refuses a cart by), and "open"
 * means exactly what the storefront's `onlineBooking.open` means. The eligibility and state
 * rules are not re-tested here; they have their own specs and are not re-implemented.
 */
describe('OrganizerSaleEligibilityService', () => {
  const user = { id: 'u1', roles: [Role.ORGANIZER_OWNER] } as unknown as RequestUser;

  const answer = (id: string, verdict: Record<string, unknown>, state = 'SELLING') => ({
    state: {
      sessionId: id,
      eventId: 'e1',
      state,
      reasons: [],
      openTicketTypeIds: ['t2'],
      closedTicketTypeIds: [],
    },
    eligibility: verdict,
  });

  function build(answers: ReturnType<typeof answer>[] = [], events: unknown[] = []) {
    const prisma = { event: { findMany: jest.fn().mockResolvedValue(events) } };
    const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
    const eligibility = {
      sessionStates: jest.fn().mockResolvedValue(answers),
      eventStates: jest.fn((evs: { id: string }[]) =>
        Promise.resolve(evs.map((e) => ({ eventId: e.id, state: 'SELLING' }))),
      ),
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
    const { svc, access } = build();
    await svc.forSessions(user, 'org1', ['s1']);
    await svc.forEvents(user, 'org1', ['e1']);
    for (const call of access.assertMember.mock.calls)
      expect(call).toEqual([user, 'org1', [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER]]);
    expect(access.assertMember).toHaveBeenCalledTimes(2);
  });

  it('asks only about the shows that belong to the organization', async () => {
    const { svc, eligibility } = build([
      answer('mine', { sellable: true, sellableTicketTypeIds: ['t1'], blockers: [] }),
    ]);
    const out = await svc.forSessions(user, 'org1', ['mine', 'theirs']);
    expect(eligibility.sessionStates).toHaveBeenCalledWith(
      { id: { in: ['mine', 'theirs'] }, event: { organizationId: 'org1' } },
      expect.any(Date),
    );
    expect(out.sessions.map((s) => s.sessionId)).toEqual(['mine']);
    expect(out.sessions[0]).toMatchObject({
      state: 'SELLING',
      eventId: 'e1',
      openTicketTypeIds: ['t2'],
      closedTicketTypeIds: [],
    });
  });

  it('says a show checkout refuses is not open, with the organizer sentence and no buyer copy', async () => {
    const { svc } = build([answer('s1', telangana, 'NOT_SELLING')]);
    const [s] = (await svc.forSessions(user, 'org1', ['s1'])).sessions;
    expect(s.open).toBe(false);
    expect(s.sellable).toBe(false);
    expect(s.state).toBe('NOT_SELLING');
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
    const { svc } = build([
      answer('s1', { ...telangana, sellableTicketTypeIds: ['t2'] }, 'PARTIAL'),
    ]);
    const [s] = (await svc.forSessions(user, 'org1', ['s1'])).sessions;
    expect(s.open).toBe(true);
    expect(s.sellable).toBe(false);
    expect(s.state).toBe('PARTIAL');
  });

  it('answers only the events of the organization, with their status and the organizer status', async () => {
    const { svc, prisma, eligibility } = build(
      [],
      [{ id: 'mine', status: 'PUBLISHED', organization: { status: 'SUSPENDED' } }],
    );
    const out = await svc.forEvents(user, 'org1', ['mine', 'theirs', 'mine']);
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['mine', 'theirs'] }, organizationId: 'org1' },
      select: { id: true, status: true, organization: { select: { status: true } } },
    });
    expect(eligibility.eventStates).toHaveBeenCalledWith(
      [{ id: 'mine', status: 'PUBLISHED', organizationSuspended: true }],
      expect.any(Date),
    );
    expect(out.events.map((e) => e.eventId)).toEqual(['mine']);
  });

  it('refuses more than the caps and asks nothing for an empty list', async () => {
    const { svc, prisma, eligibility } = build();
    const many = (n: number) => Array.from({ length: n + 1 }, (_, i) => `x${i}`);
    await expect(
      svc.forSessions(user, 'org1', many(SALE_ELIGIBILITY_MAX_SESSIONS)),
    ).rejects.toThrow(/at most/);
    await expect(svc.forEvents(user, 'org1', many(SALE_ELIGIBILITY_MAX_EVENTS))).rejects.toThrow(
      /at most/,
    );
    await expect(svc.forSessions(user, 'org1', [])).resolves.toEqual({ sessions: [] });
    await expect(svc.forEvents(user, 'org1', [])).resolves.toEqual({ events: [] });
    expect(eligibility.sessionStates).not.toHaveBeenCalled();
    expect(prisma.event.findMany).not.toHaveBeenCalled();
  });
});
