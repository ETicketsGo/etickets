import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { requestContext } from './request-context';
import { safeRequestPath } from './request-path';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Attaches a correlation id to every request and echoes it on the response. */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && incoming.trim().length > 0 ? incoming : randomUUID();
    (req as Request & { correlationId: string }).correlationId = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);
    // The rest of the request runs inside this context, so an audit row written deep in a
    // service can say which request it belongs to. See `request-context.ts`.
    requestContext.run({ correlationId, method: req.method, path: safeRequestPath(req) }, next);
  }
}
