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
        conversion: { total: 10, confirmed: 8, rate: 0.8 },
        revenue: { grossMinor: 500000 },
        topTicketType: { name: 'VIP', quantity: 5 },
        capacity: { utilization: 0.5 },
      }),
    };
    const svc = makeService(analytics);
    const res = await svc.ask(user, 'org1', 'which ticket type is selling best?');
    expect(res.answer).toContain('VIP');
    expect(res.sources).toContain('analytics.topTicketType');
    expect(res.generated).toBe(false); // AI disabled → deterministic answer
  });
});

describe('OrganizerAiService.ask — today’s sales sit behind the financial gate', () => {
  /*
    The refund and coupon answers read gated analytics, so check-in staff were told those were
    restricted. "Today" queried bookings directly and told the same staff member the takings.
    `revenue` is absent from the analytics exactly when the caller may not see money.
  */
  const nonFinancial = {
    conversion: { total: 10, confirmed: 8, rate: 0.8 },
    topTicketType: null,
    capacity: { utilization: 0.5 },
  };

  function withBookings(aggregate: jest.Mock, analytics: unknown) {
    return new OrganizerAiService(
      { booking: { aggregate } } as never,
      {} as never,
      { organizer: jest.fn().mockResolvedValue(analytics) } as never,
      fallbackGateway as never,
      ai as never,
    );
  }

  it('does not tell a member who may not see money what the organization took today', async () => {
    const aggregate = jest.fn();
    const res = await withBookings(aggregate, nonFinancial).ask(
      user,
      'org1',
      'how much did we sell today?',
    );
    expect(res.answer).toMatch(/restricted to owners and managers/i);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('still answers an owner or manager', async () => {
    const aggregate = jest
      .fn()
      .mockResolvedValue({ _sum: { totalMinor: 150000 }, _count: { _all: 3 } });
    const res = await withBookings(aggregate, { ...nonFinancial, revenue: [] }).ask(
      user,
      'org1',
      'how much did we sell today?',
    );
    expect(res.answer).toContain('3 confirmed booking');
    expect(aggregate).toHaveBeenCalled();
  });
});
