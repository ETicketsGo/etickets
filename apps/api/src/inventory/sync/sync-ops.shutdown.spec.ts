import type { Queue } from 'bullmq';
import { SyncOpsService } from './sync-ops.service';

/**
 * Shutdown contract for the inventory-sync queue.
 *
 * Regression guard for a defect that only shows up in a container: the sync Queue is built
 * by a `useFactory` provider, and Nest does not tear down factory-produced objects, so
 * nothing closed it. An open BullMQ Queue holds an ioredis socket, an open socket holds the
 * Node event loop, and the API process therefore refused to exit after `app.close()` — every
 * SIGTERM hung until the platform's grace period expired and the container was SIGKILLed
 * (measured: 21s then exit 137, versus 1s and exit 0 once this hook exists).
 *
 * That is invisible to a normal unit test and invisible in local dev; it only bites on a
 * platform that restarts containers, which is every deploy on Railway. Asserting the hook
 * exists and closes the queue is the cheapest durable guard against it regressing.
 */
describe('SyncOpsService shutdown', () => {
  function makeService(close: jest.Mock) {
    const queue = { close } as unknown as Queue;
    // Only the queue participates in shutdown; the other collaborators are irrelevant here.
    return new SyncOpsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      queue,
    );
  }

  it('closes the sync queue so the process can exit', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    await makeService(close).onModuleDestroy();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('never lets a close failure block shutdown', async () => {
    // A Redis already gone at teardown must not turn a clean stop into a hung container.
    const close = jest.fn().mockRejectedValue(new Error('connection already gone'));
    await expect(makeService(close).onModuleDestroy()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('survives a synchronous throw, so the rest of the shutdown chain still runs', async () => {
    // Nest runs destroy hooks in sequence; a synchronous throw from this one would abort
    // the remaining teardown and reinstate the hang it exists to prevent.
    const close = jest.fn(() => {
      throw new TypeError('close is not a function');
    });
    await expect(makeService(close).onModuleDestroy()).resolves.toBeUndefined();
  });
});
