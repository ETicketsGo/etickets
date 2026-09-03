import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { metricsAccess } from '@eticketsgo/shared-types';
import type { Request } from 'express';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * Gate on the Prometheus scrape endpoint.
 *
 * The route stays `@Public()` — a scraper has no user and cannot hold a JWT, so the normal
 * auth guard is the wrong instrument. This one runs in its place and checks a single
 * long-lived credential, `METRICS_TOKEN`.
 *
 * The decision itself is in `@eticketsgo/shared-types` so the worker's raw HTTP handler
 * applies the identical rule; see the reasoning there for why an unset token is open on a
 * developer's machine and closed everywhere else.
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const decision = metricsAccess({
      token: this.config.get<string>('METRICS_TOKEN'),
      authorization: request.headers.authorization,
      appEnv: this.config.get<string>('APP_ENV'),
    });

    if (decision === 'allow') return true;

    /*
      404, not 403, when no token is configured: the endpoint is genuinely not available in
      that deployment, and saying "forbidden" would confirm to anyone asking that there IS
      a metrics endpoint here worth coming back for.

      401 when a token IS configured and the request failed it — that distinction is for
      whoever is debugging a scraper, and it tells an attacker nothing they could not learn
      by trying an empty token.
    */
    if (decision === 'disabled') {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Not found', HttpStatus.NOT_FOUND);
    }
    throw new AppException(
      ErrorCodes.UNAUTHORIZED,
      'Metrics require a valid scrape token.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
