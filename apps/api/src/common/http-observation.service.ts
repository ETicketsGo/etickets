import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MetricsService } from '../metrics/metrics.service';
import { safeRequestPath } from './request-path';

/**
 * One request, one log line, one metric — whatever route it did or did not match.
 *
 * ── WHY THIS IS A SERVICE AND NOT LOGIC INSIDE THE INTERCEPTOR ─────────────────────
 * An interceptor only runs for a request Nest has MATCHED to a handler. A request to a path
 * that matches nothing goes straight to the global exception filter, so it produced a 404 for
 * the client, one line from the filter, and nothing at all in the request log or the metrics.
 *
 * That is the shape of scanner and probe traffic — the requests one most wants counted — and
 * it was invisible. Fixing it needs something that runs before routing, which means middleware;
 * keeping matched routes working needs the interceptor. Two call sites, and the one thing that
 * must not happen is for a matched request to be recorded twice, because a doubled error rate
 * is exactly as untrustworthy as a hidden one.
 *
 * So neither of them records. Both ARM this, it latches on the request object, and whichever
 * arrives first is the only one that counts. Middleware runs before routing, so in practice it
 * always wins and the interceptor's call is a no-op — which also means the timing starts before
 * the guards rather than after them, and the measured duration is closer to what the client
 * experienced. The interceptor still arms, so matched routes stay observed even if the
 * middleware registration is ever lost.
 */

/** The latch. A symbol so it cannot collide with anything Express or a library puts on `req`. */
const ARMED = Symbol('httpObservationArmed');

type ObservableRequest = Request & { [ARMED]?: true; correlationId?: string };

@Injectable()
export class HttpObservationService {
  private readonly logger = new Logger('Request');

  /**
   * What an aborted request is counted as.
   *
   * A client that hangs up before the response is written leaves `res.statusCode` at whatever
   * default Express set, which is a 2xx — the exact lie this whole area exists to stop telling.
   * It is also not nothing worth knowing: a run of them is a client timing out, a load balancer
   * giving up, or a handler too slow to answer.
   *
   * So they are recorded under 499, nginx's long-standing "client closed request". It is not a
   * real IANA status and is never sent to anybody; it exists so these land in `4xx`, where an
   * operator will see them, rather than inflating success.
   */
  private static readonly CLIENT_CLOSED_REQUEST = 499;

  constructor(private readonly metrics: MetricsService) {}

  /**
   * Arrange for this request to be recorded exactly once, when its response completes.
   *
   * Safe to call repeatedly and from anywhere in the pipeline; the second and later calls do
   * nothing. Returns nothing deliberately — no caller should be branching on whether it was
   * the one that armed.
   */
  arm(req: Request, res: Response): void {
    const request = req as ObservableRequest;
    if (request[ARMED]) return;
    request[ARMED] = true;

    const start = Date.now();

    /*
      `finish` and `close` can both fire for one response — normally `finish` first, then
      `close`. The second latch keeps that to a single record.
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
      const status = completed ? res.statusCode : HttpObservationService.CLIENT_CLOSED_REQUEST;
      this.record(request, status, start, !completed);
    };

    res.once('finish', finalize);
    res.once('close', finalize);
  }

  /**
   * The single-line JSON record, matching the worker's log shape.
   *
   * Only the whitelisted fields below are emitted. Request bodies, auth headers, tokens,
   * payment payloads and PII are never included — `path` is the pathname only, with the
   * credential segment of a secret-bearing webhook route redacted, and never the query string.
   */
  private record(req: ObservableRequest, status: number, start: number, aborted: boolean): void {
    const ms = Date.now() - start;
    const method = req.method;
    const path = safeRequestPath(req);
    const correlationId = req.correlationId ?? '-';

    // Metrics are best-effort and never throw (guarded in MetricsService).
    this.metrics.observeHttp(method, status, ms / 1000);

    // Probes are counted but not logged, so an hourly heartbeat does not bury everything else.
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
        // Present only when true, so the ordinary line keeps its existing shape.
        ...(aborted ? { aborted: true } : {}),
        msg: 'request',
      }),
    );
  }
}
