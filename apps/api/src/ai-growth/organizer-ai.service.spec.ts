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
