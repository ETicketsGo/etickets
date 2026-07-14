import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCodes } from '../common/errors';
import { MaintenanceService } from './maintenance.service';

/**
 * Global guard that returns 503 for non-exempt requests while maintenance mode
 * is ON. Guarantees:
 *
 *  - OFF by default — when the flag is unset the guard is a pass-through, so
 *    existing flows and e2e behave exactly as before.
 *  - FAIL-OPEN — the flag is read via {@link MaintenanceService.isActive}, which
 *    is cached and never throws; an unreachable Redis is treated as OFF.
 *  - EXEMPT ALWAYS (so probes/scrapers keep working and admins can turn it off):
 *      /<prefix>/health, /<prefix>/ready, /<prefix>/metrics,
 *      everything under /<prefix>/auth/*, and everything under /<prefix>/admin/*
 *      (which includes the maintenance + ops endpoints themselves).
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  private readonly prefix: string;

  constructor(
    private readonly maintenance: MaintenanceService,
    config: ConfigService,
  ) {
    this.prefix = config.get<string>('API_GLOBAL_PREFIX', 'api');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<{ path?: string; url?: string }>();
    const path = (req.path ?? req.url ?? '').split('?')[0];
    if (this.isExempt(path)) return true;

    const state = await this.maintenance.isActive();
    if (!state.enabled) return true;

    const message =
      state.message && state.message.trim().length > 0
        ? state.message
        : 'ETicketsGo is temporarily down for maintenance. Please try again shortly.';
    throw new AppException(ErrorCodes.MAINTENANCE_MODE, message, HttpStatus.SERVICE_UNAVAILABLE, {
      maintenance: true,
    });
  }

  /** True for routes that must NEVER be blocked by maintenance mode. */
  private isExempt(path: string): boolean {
    const base = this.prefix ? `/${this.prefix}` : '';
    let route = path;
    if (base && (route === base || route.startsWith(`${base}/`))) {
      route = route.slice(base.length) || '/';
    }
    return (
      route === '/health' ||
      route === '/ready' ||
      route === '/metrics' ||
      route === '/auth' ||
      route.startsWith('/auth/') ||
      route === '/admin' ||
      route.startsWith('/admin/')
    );
  }
}
