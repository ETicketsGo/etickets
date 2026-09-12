import { OrganizerAiService } from './organizer-ai.service';
import { AppException, ErrorCodes } from '../common/errors';
import { HttpStatus } from '@nestjs/common';

const user = { id: 'u1', email: 'o@x.test', fullName: 'O', roles: [] } as never;
const fallbackGateway = { run: jest.fn().mockResolvedValue({ ok: false, fallback: true }) };
const ai = { isEnabled: () => false };

function makeService(analytics: unknown) {
  return new OrganizerAiService(
    {} as never,
    {} as never,
    analytics as never,
    fallbackGateway as never,
    ai as never,
  );
}

describe('OrganizerAiService.ask — tenant isolation (WS10)', () => {
  it('delegates tenancy to analytics.organizer and rejects cross-tenant access', async () => {
    const analytics = {
      organizer: jest
        .fn()
        .mockRejectedValue(
          new AppException(ErrorCodes.TENANT_FORBIDDEN, 'no', HttpStatus.FORBIDDEN),
        ),
    };
    const svc = makeService(analytics);
    await expect(svc.ask(user, 'other-org', 'how are sales?')).rejects.toBeInstanceOf(AppException);
    expect(analytics.organizer).toHaveBeenCalledWith(user, 'other-org');
  });

  it('answers only from the authorized analytics (no fabricated metrics)', async () => {
    const analytics = {
      organizer: jest.fn().mockResolvedValue({
        // The analytics service returns these as PERCENTAGES (52 means 52%).
        conversion: { total: 10, confirmed: 8, rate: 80 },
        revenue: [{ grossMinor: 500000, currency: 'INR' }],
        topTicketType: { name: 'VIP', quantity: 5 },
        capacity: { utilization: 50 },
      }),
    };
    const svc = makeService(analytics);
    const res = await svc.ask(user, 'org1', 'which ticket type is selling best?');
    expect(res.answer).toContain('VIP');
    expect(res.sources).toContain('analytics.topTicketType');
    expect(res.generated).toBe(false); // AI disabled → deterministic answer
  });
});

/*
  Found by QA: "12 confirmed of 23 bookings (5200% conversion)". The analytics service already
  returns the rate as a percentage, and the assistant multiplied it by 100 again — as it did the
  capacity utilization in the pre-event checklist.
*/
describe('OrganizerAiService.ask — percentages are stated once', () => {
  const analytics = {
    organizer: jest.fn().mockResolvedValue({
      conversion: { total: 23, confirmed: 12, rate: 52 },
      revenue: [],
      topTicketType: null,
      capacity: { sold: 50, capacity: 100, utilization: 50 },
    }),
  };

  it('reports the conversion rate as given', async () => {
    const res = await makeService(analytics).ask(user, 'org1', 'How are sales performing?');
    expect(res.answer).toContain('(52% conversion)');
  });

  it('reports capacity utilization as given', async () => {
    const res = await makeService(analytics).ask(user, 'org1', 'what should I review before?');
    expect(res.answer).toContain('50% of capacity');
  });
});

describe('OrganizerAiService.ask — today’s sales sit behind the financial gate', () => {
  /*
    The refund and coupon answers read gated analytics, so check-in staff were told those were
    restricted. "Today" queried bookings directly and told the same staff member the takings.
    `revenue` is absent from the analytics exactly when the caller may not see money.
  */
  const nonFinancial = {
    conversion: { total: 10, confirmed: 8, rate: 80 },
    topTicketType: null,
    capacity: { utilization: 50 },
  };

  function withBookings(groupBy: jest.Mock, analytics: unknown) {
    return new OrganizerAiService(
      { booking: { groupBy } } as never,
      {} as never,
      { organizer: jest.fn().mockResolvedValue(analytics) } as never,
      fallbackGateway as never,
      ai as never,
    );
  }

  it('does not tell a member who may not see money what the organization took today', async () => {
    const groupBy = jest.fn();
    const res = await withBookings(groupBy, nonFinancial).ask(
      user,
      'org1',
      'how much did we sell today?',
    );
    expect(res.answer).toMatch(/restricted to owners and managers/i);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('still answers an owner or manager', async () => {
    const groupBy = jest
      .fn()
      .mockResolvedValue([{ currency: 'INR', _sum: { totalMinor: 150000 }, _count: { _all: 3 } }]);
    const res = await withBookings(groupBy, { ...nonFinancial, revenue: [] }).ask(
      user,
      'org1',
      'how much did we sell today?',
    );
    expect(res.answer).toContain('3 confirmed booking');
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ['currency'] }));
  });

  it('states one figure per currency instead of adding rupees to dollars', async () => {
    // Found by QA: "totalling INR 57.2" — every booking summed into one unlabelled number.
    const groupBy = jest.fn().mockResolvedValue([
      { currency: 'INR', _sum: { totalMinor: 150000 }, _count: { _all: 3 } },
      { currency: 'USD', _sum: { totalMinor: 2500 }, _count: { _all: 1 } },
    ]);
    const res = await withBookings(groupBy, { ...nonFinancial, revenue: [] }).ask(
      user,
      'org1',
      'how much did we sell today?',
    );
    expect(res.answer).toContain('4 confirmed booking');
    expect(res.answer).toMatch(/INR|₹/);
    expect(res.answer).toMatch(/USD|\$/);
    expect(res.answer).toContain(' and ');
  });
});
