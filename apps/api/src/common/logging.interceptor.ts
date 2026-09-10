import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request, Response } from 'express';
import { HttpObservationService } from './http-observation.service';

/**
 * Observes matched routes.
 *
 * ── WHY THIS STILL EXISTS ALONGSIDE THE MIDDLEWARE ─────────────────────────────────
 * `HttpObservationMiddleware` runs before routing and therefore sees every request,
 * including the ones that match no handler — so in practice it always arms first and this
 * interceptor's call is a no-op. It is kept so that a matched route stays observed even if
 * the middleware registration is ever lost, which is a one-line edit in `AppModule` away.
 *
 * Arming twice is free: {@link HttpObservationService.arm} latches on the request object, so
 * one request yields one log line and one metric observation however many places ask.
 *
 * ── WHY NEITHER OF THEM READS THE STATUS HERE ──────────────────────────────────────
 * This used to record from `tap({ next, error })`. On the error path the tap fires BEFORE
 * Nest hands the exception to the filter that decides the status and writes the response, so
 * the status read was whatever Express had defaulted to — 200 for GET, 201 for POST — and
 * every failed request was recorded as a success, in the metrics as well as the log. The
 * response's own lifecycle is the only thing that knows the final status, because it is the
 * thing that wrote it.
 *
 * The handler's stream is returned untouched: nothing here subscribes to it, catches from it,
 * or maps it, so an exception reaches the exception filter exactly as it would otherwise.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly observation: HttpObservationService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    this.observation.arm(http.getRequest<Request>(), http.getResponse<Response>());
    return next.handle();
  }
}
