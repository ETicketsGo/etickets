import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Structured request logging: emits a single-line JSON object per request with
 * a fixed, safe field set — matching the worker's JSON log shape. It also feeds
 * the HTTP metrics (counter + duration histogram) from the same timing.
 *
 * Safety: only the whitelisted fields below are logged. Request bodies, auth
 * headers, tokens, payment payloads and PII (e.g. emails, query strings that
 * may carry them) are never emitted — `path` is the pathname only.
 * Health/readiness probes are skipped for logging to keep logs quiet, but are
 * still counted in metrics.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const res = http.getResponse<Response>();

    const start = Date.now();
    const correlationId = req.correlationId ?? '-';
    return next.handle().pipe(
      tap({
        next: () => this.record(req, res.statusCode, start, correlationId),
        error: () => this.record(req, res.statusCode || 500, start, correlationId),
      }),
    );
  }

  private record(req: Request, status: number, start: number, correlationId: string): void {
    const ms = Date.now() - start;
    const method = req.method;
    // Pathname only — never the query string (may carry tokens/PII).
    const path = (req.originalUrl || req.url || '').split('?')[0];

    // Metrics are best-effort and never throw (guarded in MetricsService).
    this.metrics.observeHttp(method, status, ms / 1000);

    // Preserve prior behaviour: probes don't produce a log line.
    if (path === '/api/health' || path === '/api/ready') {
      return;
    }

    this.logger.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        method,
        path,
        status,
        ms,
        correlationId,
        msg: 'request',
      }),
    );
  }
}
