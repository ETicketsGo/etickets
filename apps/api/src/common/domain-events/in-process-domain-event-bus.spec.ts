import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { DomainEventFactory } from './domain-event.factory';
import { DuplicateSubscriptionError, InvalidDomainEventError } from './domain-event.errors';
import { InProcessDomainEventBus } from './in-process-domain-event-bus';
import type { DomainEvent } from './domain-event';
import type { DomainEventHandler } from './domain-event-handler';

function makeBus(opts: { enabled?: boolean; timeoutMs?: number } = {}) {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'DOMAIN_EVENTS_ENABLED') return opts.enabled ?? true;
      if (key === 'DOMAIN_EVENT_HANDLER_TIMEOUT_MS') return opts.timeoutMs ?? 5000;
      return undefined;
    }),
  } as unknown as ConfigService;
  const metrics = {
    recordDomainEventPublished: jest.fn(),
    recordDomainEventHandler: jest.fn(),
  } as unknown as MetricsService;
  const bus = new InProcessDomainEventBus(config, metrics);
  return { bus, metrics };
}

const evt = (over: Partial<DomainEvent> = {}): DomainEvent =>
  DomainEventFactory.create({
    eventType: 'booking.confirmed',
    aggregateType: 'Booking',
    aggregateId: 'bk_1',
    payload: { bookingId: 'bk_1' },
    ...over,
  });

function handler(name: string, impl?: () => Promise<void>): DomainEventHandler {
  return { handlerName: name, handle: jest.fn(impl ?? (() => Promise.resolve())) };
}

describe('InProcessDomainEventBus', () => {
  it('delivers an event to a single subscribed handler', async () => {
    const { bus } = makeBus();
    const h = handler('h1');
    bus.subscribe('booking.confirmed', h);
    const e = evt();
    await bus.publish(e);
    expect(h.handle).toHaveBeenCalledWith(e);
  });

  it('runs multiple handlers sequentially in registration order', async () => {
    const { bus } = makeBus();
    const order: string[] = [];
    bus.subscribe(
      'booking.confirmed',
      handler('h1', async () => void order.push('h1')),
    );
    bus.subscribe(
      'booking.confirmed',
      handler('h2', async () => void order.push('h2')),
    );
    await bus.publish(evt());
    expect(order).toEqual(['h1', 'h2']);
  });

  it('isolates a failing handler so the others still receive the event', async () => {
    const { bus, metrics } = makeBus();
    const bad = handler('bad', async () => {
      throw new Error('boom');
    });
    const good = handler('good');
    bus.subscribe('booking.confirmed', bad);
    bus.subscribe('booking.confirmed', good);

    await expect(bus.publish(evt())).resolves.toBeUndefined(); // publish never rejects
    expect(good.handle).toHaveBeenCalled();
    expect(metrics.recordDomainEventHandler).toHaveBeenCalledWith(
      'booking.confirmed',
      'bad',
      'error',
      expect.any(Number),
    );
  });

  it('no-handler events resolve and are counted, not errored', async () => {
    const { bus, metrics } = makeBus();
    await expect(bus.publish(evt())).resolves.toBeUndefined();
    expect(metrics.recordDomainEventPublished).toHaveBeenCalledWith(
      'booking.confirmed',
      'no_handler',
    );
  });

  it('rejects a duplicate subscription (same handler identity + type)', () => {
    const { bus } = makeBus();
    bus.subscribe('booking.confirmed', handler('dup'));
    expect(() => bus.subscribe('booking.confirmed', handler('dup'))).toThrow(
      DuplicateSubscriptionError,
    );
  });

  it('is a no-op when DOMAIN_EVENTS_ENABLED is off (handler never runs)', async () => {
    const { bus, metrics } = makeBus({ enabled: false });
    const h = handler('h1');
    bus.subscribe('booking.confirmed', h);
    await bus.publish(evt());
    expect(h.handle).not.toHaveBeenCalled();
    expect(metrics.recordDomainEventPublished).toHaveBeenCalledWith(
      'booking.confirmed',
      'disabled',
    );
  });

  it('skips a handler whose declared versions exclude the event version (visible, not silent)', async () => {
    const { bus, metrics } = makeBus();
    const h = handler('v2only');
    bus.subscribe('booking.confirmed', h, { versions: [2] });
    await bus.publish(evt({ eventVersion: 1 }));
    expect(h.handle).not.toHaveBeenCalled();
    expect(metrics.recordDomainEventHandler).toHaveBeenCalledWith(
      'booking.confirmed',
      'v2only',
      'skipped',
      0,
    );
  });

  it('times out a hung handler as an isolated failure', async () => {
    const { bus, metrics } = makeBus({ timeoutMs: 20 });
    const hung = handler('hung', () => new Promise<void>(() => {}));
    const after = handler('after');
    bus.subscribe('booking.confirmed', hung);
    bus.subscribe('booking.confirmed', after);
    await bus.publish(evt());
    expect(after.handle).toHaveBeenCalled(); // not blocked by the hung handler
    expect(metrics.recordDomainEventHandler).toHaveBeenCalledWith(
      'booking.confirmed',
      'hung',
      'error',
      expect.any(Number),
    );
  });

  it('throws on a malformed event (producer bug), not swallowed', async () => {
    const { bus } = makeBus();
    const bad = { eventType: '', payload: {} } as unknown as DomainEvent;
    await expect(bus.publish(bad)).rejects.toBeInstanceOf(InvalidDomainEventError);
  });

  it('publishMany dispatches in order', async () => {
    const { bus } = makeBus();
    const seen: string[] = [];
    bus.subscribe(
      'booking.confirmed',
      handler('h', async () => void seen.push('x')),
    );
    await bus.publishMany([evt(), evt()]);
    expect(seen).toEqual(['x', 'x']);
  });
});
