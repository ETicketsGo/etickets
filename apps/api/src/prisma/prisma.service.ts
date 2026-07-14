import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { MetricsService } from '../metrics/metrics.service';

/** Resolve the slow-query threshold (ms) from env, defaulting to 500. */
export function resolveSlowQueryMs(raw: string | undefined = process.env.SLOW_QUERY_MS): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/**
 * Handle one Prisma query event: always observe the duration histogram; when the
 * query is over the threshold, bump the slow counter and emit a structured JSON
 * warn line. The line carries duration + operation target ONLY — never the SQL
 * text or params, so no PII/secrets leak. Best-effort: never throws.
 *
 * Extracted as a pure function so it can be unit-tested without a live database.
 */
export function reportQueryEvent(
  event: Pick<Prisma.QueryEvent, 'duration' | 'target'>,
  thresholdMs: number,
  metrics?: Pick<MetricsService, 'observeDbQuery'>,
  logWarn?: (line: string) => void,
): void {
  try {
    const ms = event.duration;
    const slow = ms >= thresholdMs;
    metrics?.observeDbQuery(ms / 1000, slow);
    if (slow) {
      logWarn?.(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'slow query',
          ms,
          thresholdMs,
          target: event.target,
        }),
      );
    }
  } catch {
    /* instrumentation is best-effort */
  }
}

/**
 * PrismaService with an opt-in-cost slow-query observer.
 *
 * The client is constructed with a `query` *event* emitter (not stdout logging),
 * so nothing is printed by default and existing queries are unaffected. For every
 * query we observe a duration histogram; only queries slower than SLOW_QUERY_MS
 * emit a structured JSON warn line and bump the slow-query counter.
 *
 * MetricsService is optional so the service can be constructed in isolation
 * (e.g. the worker, or tests) without the metrics module.
 */
@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'query'>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly slowQueryLogger = new Logger('SlowQuery');
  private readonly slowQueryMs = resolveSlowQueryMs();

  constructor(@Optional() private readonly metrics?: MetricsService) {
    super({ log: [{ emit: 'event', level: 'query' }] });
  }

  async onModuleInit(): Promise<void> {
    this.registerSlowQueryListener();
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Wire the query-event listener. Best-effort; a failure here must not break boot. */
  private registerSlowQueryListener(): void {
    try {
      this.$on('query', (e: Prisma.QueryEvent) =>
        reportQueryEvent(e, this.slowQueryMs, this.metrics, (line) =>
          this.slowQueryLogger.warn(line),
        ),
      );
    } catch {
      /* if the emitter is unavailable, silently skip instrumentation */
    }
  }
}
