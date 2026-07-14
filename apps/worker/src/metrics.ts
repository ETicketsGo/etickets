import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import type { Queue } from 'bullmq';

/**
 * The worker owns the BullMQ queue, so it — not the API — is the correct process
 * to expose queue depth. It publishes its own Prometheus registry on
 * `GET :WORKER_PORT/metrics`; Prometheus scrapes both the API and the worker.
 *
 * `etg_queue_jobs{queue,state}` is a bounded-cardinality gauge (one series per
 * queue×state) periodically refreshed from `queue.getJobCounts()`.
 */
export const workerRegistry = new Registry();
collectDefaultMetrics({ register: workerRegistry });

const workerUp = new Gauge({
  name: 'etg_worker_up',
  help: 'Worker process liveness (always 1 while the metrics endpoint is served).',
  registers: [workerRegistry],
});
workerUp.set(1);

const queueJobs = new Gauge({
  name: 'etg_queue_jobs',
  help: 'BullMQ job counts by queue and state (waiting/active/completed/failed/delayed/paused).',
  labelNames: ['queue', 'state'],
  registers: [workerRegistry],
});

const sampleErrors = new Gauge({
  name: 'etg_queue_sample_errors_total',
  help: 'Count of failed attempts to sample queue job counts (Redis unreachable, etc.).',
  registers: [workerRegistry],
});

let sampleErrorCount = 0;

/**
 * Sample one queue's job counts into the gauge. Best-effort and never throws —
 * a Redis blip must not crash the worker; it just bumps an error gauge.
 */
export async function sampleQueueMetrics(queue: Queue): Promise<void> {
  try {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    for (const [state, value] of Object.entries(counts)) {
      queueJobs.set({ queue: queue.name, state }, value ?? 0);
    }
  } catch {
    sampleErrors.set((sampleErrorCount += 1));
  }
}

/** Prometheus exposition text + content type for the worker's /metrics endpoint. */
export async function renderWorkerMetrics(): Promise<{ body: string; contentType: string }> {
  return { body: await workerRegistry.metrics(), contentType: workerRegistry.contentType };
}
