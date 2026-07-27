import { MetricsService } from '../../../metrics/metrics.service';
import { InProcessDomainEventBus } from '../in-process-domain-event-bus';
import { DomainEventBusDeliveryAdapter } from './outbox-delivery.adapter';
import { ProcessedEventStore } from './processed-event.store';
import { OutboxDeliveryRetryableError } from './outbox.errors';
import { DomainEventFactory } from '../domain-event.factory';

const event = () =>
  DomainEventFactory.create({
    eventType: 'booking.confirmed',
    aggregateType: 'Booking',
    aggregateId: 'b1',
    payload: { bookingId: 'b1' },
  });

function make(opts: {
  handlers?: string[];
  claims?: Record<string, 'CLAIMED' | 'ALREADY_COMPLETED' | 'IN_PROGRESS'>;
  exec?: Record<string, { ok: boolean; skipped?: boolean }>;
}) {
  const bus = {
    handlersFor: jest.fn().mockReturnValue(opts.handlers ?? ['h1']),
    executeHandler: jest.fn(
      async (_t: string, name: string) => opts.exec?.[name] ?? { ok: true, skipped: false },
    ),
  } as unknown as InProcessDomainEventBus;
  const completed: string[] = [];
  const store = {
    claim: jest.fn(async (_e: string, name: string) => opts.claims?.[name] ?? 'CLAIMED'),
    markCompleted: jest.fn(async (_e: string, name: string) => void completed.push(name)),
    markFailed: jest.fn(),
  } as unknown as ProcessedEventStore;
  const adapter = new DomainEventBusDeliveryAdapter(bus, store, new MetricsService());
  return { adapter, bus, store, completed };
}

describe('DomainEventBusDeliveryAdapter', () => {
  it('marks all handlers completed and resolves when every handler succeeds', async () => {
    const { adapter, completed } = make({ handlers: ['h1', 'h2'] });
    await expect(adapter.deliver(event())).resolves.toBeUndefined();
    expect(completed).toEqual(['h1', 'h2']);
  });

  it('throws retryable (not delivered) when a handler fails', async () => {
    const { adapter, store } = make({ handlers: ['h1'], exec: { h1: { ok: false } } });
    await expect(adapter.deliver(event())).rejects.toBeInstanceOf(OutboxDeliveryRetryableError);
    expect(store.markFailed).toHaveBeenCalled();
  });

  it('skips an already-completed handler (idempotent replay) and does not re-run it', async () => {
    const { adapter, bus } = make({ handlers: ['h1'], claims: { h1: 'ALREADY_COMPLETED' } });
    await expect(adapter.deliver(event())).resolves.toBeUndefined();
    expect(bus.executeHandler).not.toHaveBeenCalled(); // side effect never repeated
  });

  it('does not re-run a completed handler while a sibling is still pending (retry)', async () => {
    const { adapter, bus } = make({
      handlers: ['done', 'pending'],
      claims: { done: 'ALREADY_COMPLETED', pending: 'CLAIMED' },
      exec: { pending: { ok: false } },
    });
    await expect(adapter.deliver(event())).rejects.toBeInstanceOf(OutboxDeliveryRetryableError);
    expect(bus.executeHandler).toHaveBeenCalledTimes(1); // only the pending one ran
    expect(bus.executeHandler).toHaveBeenCalledWith(
      'booking.confirmed',
      'pending',
      expect.anything(),
    );
  });

  it('treats an IN_PROGRESS claim as not-yet-complete (retry, run nothing)', async () => {
    const { adapter, bus } = make({ handlers: ['h1'], claims: { h1: 'IN_PROGRESS' } });
    await expect(adapter.deliver(event())).rejects.toBeInstanceOf(OutboxDeliveryRetryableError);
    expect(bus.executeHandler).not.toHaveBeenCalled();
  });

  it('no handlers ⇒ delivered (nothing to do)', async () => {
    const { adapter } = make({ handlers: [] });
    await expect(adapter.deliver(event())).resolves.toBeUndefined();
  });
});
