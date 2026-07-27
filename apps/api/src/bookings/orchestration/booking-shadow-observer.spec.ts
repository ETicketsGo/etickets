import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { InventoryResolver } from '../../inventory/sourcing/inventory.resolver';
import { BookingShadowObserver } from './booking-shadow-observer.service';

function make(
  cfg: Record<string, unknown>,
  authority: 'LOCAL' | 'REMOTE' = 'LOCAL',
  resolveThrows = false,
) {
  const resolver = {
    resolve: resolveThrows
      ? jest.fn().mockRejectedValue(new Error('no provider'))
      : jest.fn().mockResolvedValue({ name: 'direct', capabilities: { authority } }),
  } as unknown as InventoryResolver;
  const config = {
    get: jest.fn((k: string, d?: unknown) => cfg[k] ?? d),
  } as unknown as ConfigService;
  const metrics = new MetricsService();
  const mismatch = jest.spyOn(metrics, 'recordBookingShadowMismatch');
  const ok = jest.spyOn(metrics, 'recordBookingShadow');
  return { observer: new BookingShadowObserver(resolver, config, metrics), resolver, mismatch, ok };
}

const ctx = {
  bookingId: 'b1',
  eventSessionId: 's1',
  experienceType: 'MOVIE' as never,
  seatCount: 2,
  quantity: 2,
};

describe('BookingShadowObserver', () => {
  it('is a no-op when the orchestrator is disabled', async () => {
    const { observer, resolver } = make({
      BOOKING_ORCHESTRATOR_ENABLED: false,
      BOOKING_ORCHESTRATOR_MODE: 'shadow',
    });
    await observer.observe(ctx);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('is a no-op in active mode (shadow only observes)', async () => {
    const { observer, resolver } = make({
      BOOKING_ORCHESTRATOR_ENABLED: true,
      BOOKING_ORCHESTRATOR_MODE: 'active',
    });
    await observer.observe(ctx);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('records observed_ok when the orchestrator would pick a LOCAL provider', async () => {
    const { observer, ok } = make(
      { BOOKING_ORCHESTRATOR_ENABLED: true, BOOKING_ORCHESTRATOR_MODE: 'shadow' },
      'LOCAL',
    );
    await observer.observe(ctx);
    expect(ok).toHaveBeenCalledWith('observed_ok', 'direct');
  });

  it('classifies PROVIDER_SELECTION_MISMATCH for a non-LOCAL provider', async () => {
    const { observer, mismatch } = make(
      { BOOKING_ORCHESTRATOR_ENABLED: true, BOOKING_ORCHESTRATOR_MODE: 'shadow' },
      'REMOTE',
    );
    await observer.observe(ctx);
    expect(mismatch).toHaveBeenCalledWith('PROVIDER_SELECTION_MISMATCH');
  });

  it('swallows a resolver failure as INVENTORY_DECISION_MISMATCH (never throws)', async () => {
    const { observer, mismatch } = make(
      { BOOKING_ORCHESTRATOR_ENABLED: true, BOOKING_ORCHESTRATOR_MODE: 'shadow' },
      'LOCAL',
      true,
    );
    await expect(observer.observe(ctx)).resolves.toBeUndefined();
    expect(mismatch).toHaveBeenCalledWith('INVENTORY_DECISION_MISMATCH');
  });
});
