import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { HumanCheckService } from './human-check.service';
import type { HumanCheckAction } from './human-check.settings';

export const HUMAN_CHECK_KEY = 'humanCheckAction';

@Injectable()
export class HumanCheckGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly humanCheck: HumanCheckService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const action = this.reflector.get<HumanCheckAction | undefined>(
      HUMAN_CHECK_KEY,
      context.getHandler(),
    );
    if (!action) return true;
    return this.humanCheck.enforce(action, context.switchToHttp().getRequest<Request>());
  }
}

/**
 * Ask a caller of this route to prove it is a person (Cloudflare Turnstile), by TURNSTILE_MODE.
 *
 * A route guard, so it runs AFTER the global ones: the throttle has already counted the
 * request and authentication has already run. A caller refused by either never costs a call
 * to Cloudflare, and an unauthenticated caller of an authenticated route gets its 401, not a
 * challenge it could not use anyway.
 *
 * `action` names the route class. It is also the Turnstile action the widget is drawn with, so
 * a token solved for one class is refused on another. See `HUMAN_CHECK_ACTIONS` for each
 * class's threshold and what it does when Cloudflare is down.
 */
export const RequiresHumanCheck = (action: HumanCheckAction) =>
  applyDecorators(SetMetadata(HUMAN_CHECK_KEY, action), UseGuards(HumanCheckGuard));
