import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { HttpObservationService } from './http-observation.service';

/**
 * Observation for every request, including the ones that match no route at all.
 *
 * ── WHY MIDDLEWARE AND NOT THE INTERCEPTOR ─────────────────────────────────────────
 * An interceptor runs only once Nest has matched a handler. A request to a path that matches
 * nothing never reaches one: it produced a 404 for the client and one line from the global
 * exception filter, with no request-log entry and no metric. Unknown paths are exactly what
 * scanning and probing traffic looks like, so the traffic most worth counting was the traffic
 * that could not be seen.
 *
 * Middleware runs before routing, so it is the only place that sees a request whether or not
 * it will match anything.
 *
 * ── WHY THIS DOES NOT DOUBLE-COUNT ─────────────────────────────────────────────────
 * It records nothing itself. It arms {@link HttpObservationService}, which latches on the
 * request object, so the interceptor arming the same request afterwards is a no-op. One
 * request produces one log line and one metric observation regardless of how many places
 * asked for it to be observed.
 */
@Injectable()
export class HttpObservationMiddleware implements NestMiddleware {
  constructor(private readonly observation: HttpObservationService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    this.observation.arm(req, res);
    next();
  }
}
