import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request, Response } from 'express';
import { MetricsService } from '../metrics/metrics.service';
import { safeRequestPath } from './request-path';

/**
 * Structured request logging: emits a single-line JSON object per request with
 * a fixed, safe field set — matching the worker's JSON log shape. It also feeds
 * the HTTP metrics (counter + duration histogram) from the same timing.
 *
 * Safety: only the whitelisted fields below are logged. Request bodies, auth
 * headers, tokens, payment payloads and PII (e.g. emails, query strings that
 * may carry them) are never emitted — `path` is the pathname only, with the
 * credential segment of a secret-bearing webhook route redacted.
 * Health/readiness probes are skipped for logging to keep logs quiet, but are
 * still counted in metrics.
 *
 * ── WHY THE STATUS IS READ AT `finish` AND NOT IN AN RxJS TAP ──────────────────────
 * This used to record from `tap({ next, error })`. On the success path that is fine. On the
 * ERROR path it is not: the observable errors, the tap fires, and only AFTERWARDS does Nest
 * hand the exception to the filter that decides the status and writes the response. So the
 * status read in the tap was whatever Express had defaulted to — 200 for GET, 201 for POST —
 * and every failed request was recorded as a success.
 *
 * That was not a cosmetic logging bug. The same value feeds `observeHttp`, so the Prometheus
 * counters said the same thing. Proven on QA: three requests that returned 401 to the client
 * produced `etg_http_requests_total{method="POST",status_class="2xx"} 3`, and no 4xx series
 * existed at all. An error-rate alert built on that metric could never fire, and the duration
 * histogram attributed every error's latency to 2xx.
 *
 * The response's own lifecycle is the only thing that knows the final status, because it is
 * the thing that wrote it. `finish` fires after the exception filter, after a redirect, after
 * anything else that may have changed the status — so there is exactly one moment when the
 * answer is knowable, and this is it.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  /**
   * What an aborted request is counted as.
   *
   * A client that hangs up before the response is written leaves `res.statusCode` at whatever
   * default Express set, which is a 2xx — the exact lie this file exists to stop telling. It
   * is also not nothing worth knowing: a run of them is a client timing out, a load balancer
   * giving up, or a handler too slow to answer.
   *
   * So they are recorded under 499, nginx's long-standing "client closed request". It is not
   * a real IANA status and is not sent to anybody; it exists so these land in `4xx`, where an
   * operator will see them, rather than inflating success.
   */
  private static readonly CLIENT_CLOSED_REQUEST = 499;

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

    /*
      Exactly one record per request.

      `finish` and `close` can both fire for the same response — normally `finish` first, then
      `close` — so without this latch a completed request would be logged and counted twice,
      which is a different way of being wrong about the same numbers.
    */
    let recorded = false;
    const finalize = (): void => {
      if (recorded) return;
      recorded = true;
      /*
        `writableFinished` is set to true immediately BEFORE `finish` is emitted, so it
        distinguishes the two paths without guessing: true means the response was fully
        written, false means `close` arrived on a response that never was.
      */
      const completed = res.writableFinished;
      const status = completed ? res.statusCode : LoggingInterceptor.CLIENT_CLOSED_REQUEST;
      this.record(req, status, start, correlationId, !completed);
    };

    res.once('finish', finalize);
    res.once('close', finalize);

    /*
      The handler's stream is returned untouched. Nothing here subscribes to it, catches from
      it, or maps it — so an exception travels to the exception filter exactly as it did
      before, and the response pipeline is not involved in the measuring of itself.
    */
    return next.handle();
  }

  private record(
    req: Request,
    status: number,
    start: number,
    correlationId: string,
    aborted: boolean,
  ): void {
    const ms = Date.now() - start;
    const method = req.method;
    // Pathname only, with the credential segment of a secret-bearing webhook route redacted.
    // Never the query string. See `request-path.ts`.
    const path = safeRequestPath(req);

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
        // Present only when it is true, so the ordinary line keeps its existing shape.
        ...(aborted ? { aborted: true } : {}),
        msg: 'request',
      }),
    );
  }
}
