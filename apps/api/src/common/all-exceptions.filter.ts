import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCodes } from './errors';

interface ErrorEnvelope {
  code: string;
  message: string;
  details: Record<string, unknown>;
  correlationId: string;
}

/** Renders every thrown error into the standard ETicketsGo error envelope. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { correlationId?: string }>();
    const correlationId = req.correlationId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ErrorEnvelope = {
      code: ErrorCodes.INTERNAL,
      message: 'Something went wrong.',
      details: {},
      correlationId,
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        body = { ...body, code: mapStatusToCode(status), message: response };
      } else if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        body = {
          code: (r.code as string) ?? mapStatusToCode(status),
          message:
            (r.message as string) ??
            (Array.isArray(r.message) ? (r.message as string[]).join(', ') : 'Request failed.'),
          details: (r.details as Record<string, unknown>) ?? {},
          correlationId,
        };
      }
    }

    if (status >= 500) {
      this.logger.error(
        `[${correlationId}] ${req.method} ${req.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${correlationId}] ${req.method} ${req.url} -> ${status} ${body.code}`);
    }

    res.status(status).json(body);
  }
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return ErrorCodes.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCodes.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCodes.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCodes.CONFLICT;
    case HttpStatus.BAD_REQUEST:
      return ErrorCodes.VALIDATION_FAILED;
    default:
      return ErrorCodes.INTERNAL;
  }
}
