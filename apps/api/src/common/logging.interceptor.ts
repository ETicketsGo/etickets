import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

/**
 * Structured request logging: method, path, status, and duration, tagged with
 * the correlation id. Health/readiness probes are skipped to keep logs quiet.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const res = http.getResponse<Response>();

    if (req.url === '/api/health' || req.url === '/api/ready') {
      return next.handle();
    }

    const start = Date.now();
    const correlationId = req.correlationId ?? '-';
    return next.handle().pipe(
      tap({
        next: () => this.log(req, res.statusCode, start, correlationId),
        error: () => this.log(req, res.statusCode || 500, start, correlationId),
      }),
    );
  }

  private log(req: Request, status: number, start: number, correlationId: string): void {
    const ms = Date.now() - start;
    this.logger.log(`${req.method} ${req.url} ${status} ${ms}ms [${correlationId}]`);
  }
}
