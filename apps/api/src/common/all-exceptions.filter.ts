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
import { captureException } from '../observability/sentry';
import { PaymentProviderError, PaymentErrorCode } from '../payments/domain/payment-errors';

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
    } else if (exception instanceof PaymentProviderError) {
      // Classify normalized payment failures instead of letting them fall through
      // to an opaque 500 (which also mis-pages Sentry for ordinary card declines).
      const mapped = mapPaymentError(exception);
      status = mapped.status;
      body = {
        code: mapped.code,
        message: mapped.message,
        details: { provider: exception.provider, reason: exception.code },
        correlationId,
      };
    }

    // Path only (never the query string — it can carry tokens/PII), matching the
    // request logging interceptor.
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (status >= 500) {
      this.logger.error(
        `[${correlationId}] ${req.method} ${path} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      // Report only unexpected server errors to Sentry (no-op unless SENTRY_DSN
      // is set). Expected 4xx AppExceptions are filtered out above by status.
      captureException(exception, {
        correlationId,
        method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
      });
    } else {
      this.logger.warn(`[${correlationId}] ${req.method} ${path} -> ${status} ${body.code}`);
    }

    res.status(status).json(body);
  }
}

/** Maps a normalized payment error to an HTTP status + safe client envelope. */
function mapPaymentError(e: PaymentProviderError): {
  status: HttpStatus;
  code: string;
  message: string;
} {
  switch (e.code) {
    case PaymentErrorCode.CARD_DECLINED:
      return {
        status: HttpStatus.PAYMENT_REQUIRED,
        code: 'PAYMENT_DECLINED',
        message: 'Your card was declined.',
      };
    case PaymentErrorCode.INSUFFICIENT_FUNDS:
      return {
        status: HttpStatus.PAYMENT_REQUIRED,
        code: 'PAYMENT_INSUFFICIENT_FUNDS',
        message: 'Insufficient funds.',
      };
    case PaymentErrorCode.INVALID_REQUEST:
    case PaymentErrorCode.UNSUPPORTED:
    case PaymentErrorCode.WEBHOOK_INVALID:
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'PAYMENT_INVALID_REQUEST',
        message: 'The payment request was invalid.',
      };
    case PaymentErrorCode.DUPLICATE:
      return {
        status: HttpStatus.CONFLICT,
        code: 'PAYMENT_DUPLICATE',
        message: 'Duplicate payment request.',
      };
    case PaymentErrorCode.PROVIDER_UNAVAILABLE:
    case PaymentErrorCode.PROVIDER_TIMEOUT:
    case PaymentErrorCode.AUTHENTICATION_FAILED:
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'The payment provider is temporarily unavailable. Please try again.',
      };
    default:
      return {
        status: HttpStatus.BAD_GATEWAY,
        code: 'PAYMENT_ERROR',
        message: 'Payment could not be processed.',
      };
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
