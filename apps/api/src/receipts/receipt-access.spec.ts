import { Role } from '@eticketsgo/shared-types';
import { ReceiptsController } from './receipts.controller';

/**
 * unit - who may read somebody else's receipt.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * The organization receipt LIST was restricted to owners and managers, with a comment saying
 * exactly why: "Every document names a buyer and an amount, and check-in staff are members
 * too." The single document, and the per-booking list that hands out its id, were not - they
 * asked only whether the caller was a member of the organization at all.
 *
 * `CHECKIN_STAFF` is a member. So a temporary gate worker with a scanner login could follow a
 * chain where every step looked harmless:
 *
 *   scan a ticket  ->  the booking id
 *   GET /receipts/booking/:id  ->  the document ids
 *   GET /receipts/:id  ->  the buyer's name, their email, and what they paid
 *
 * Found while building the dedicated gate experience, which is the point: the question "what
 * can this role actually reach" has to be asked of the API, not of the navigation.
 */

function makeController(opts: { bookingUserId?: string | null; orgId?: string } = {}) {
  const orgId = opts.orgId ?? 'org-1';
  const calls: Array<{ organizationId: string; roles?: Role[] }> = [];
  const access = {
    assertMember: jest.fn(async (_u: unknown, organizationId: string, roles?: Role[]) => {
      calls.push({ organizationId, roles });
    }),
    isPlatformAdmin: () => false,
  };
  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        userId: opts.bookingUserId === undefined ? 'buyer-1' : opts.bookingUserId,
        organizationId: orgId,
      }),
    },
  };
  const receipts = {
    document: jest.fn().mockResolvedValue({
      receipt: { organizationId: orgId, bookingId: 'b-1', number: 'R-1' },
      document: { buyer: { name: 'A Buyer', email: 'buyer@example.test' }, totals: {} },
    }),
    listForBooking: jest.fn().mockResolvedValue([]),
  };
  const controller = new ReceiptsController(receipts as never, prisma as never, access as never);
  return { controller, access, calls, receipts };
}

const STAFF = { id: 'gate-1', email: 'gate@t.test', fullName: 'Gate', roles: [] } as never;
const BUYER = { id: 'buyer-1', email: 'b@t.test', fullName: 'Buyer', roles: [] } as never;

describe('reading one receipt', () => {
  it('asks for owner or manager, not merely membership', async () => {
    const { controller, calls } = makeController();
    await controller.get(STAFF, 'r-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].roles).toEqual([Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER]);
  });

  it('still lets the buyer read their own, with no role at all', async () => {
    /*
      Checked BEFORE the organization rule and deliberately: a buyer's receipt is theirs
      whatever their organization role is, or whether they have one.
    */
    const { controller, access } = makeController({ bookingUserId: 'buyer-1' });
    await controller.get(BUYER, 'r-1');
    expect(access.assertMember).not.toHaveBeenCalled();
  });
});

describe('listing the documents for a booking', () => {
  it('asks for owner or manager too, because these ids lead to the documents', async () => {
    // Locking the document and leaving the index open would close nothing.
    const { controller, calls } = makeController();
    await controller.listForBooking(STAFF, 'b-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].roles).toEqual([Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER]);
  });

  it('still lets the buyer list their own', async () => {
    const { controller, access } = makeController({ bookingUserId: 'buyer-1' });
    await controller.listForBooking(BUYER, 'b-1');
    expect(access.assertMember).not.toHaveBeenCalled();
  });
});

describe('the rule is the same everywhere a receipt can be reached', () => {
  it('uses one role list for the document and for the index', async () => {
    /*
      The defect was two routes to the same data with two different rules. Asserting they
      agree is what stops that returning the next time a route is added.
    */
    const a = makeController();
    await a.controller.get(STAFF, 'r-1');
    const b = makeController();
    await b.controller.listForBooking(STAFF, 'b-1');
    expect(a.calls[0].roles).toEqual(b.calls[0].roles);
  });
});
