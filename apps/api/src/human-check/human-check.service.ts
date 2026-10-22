import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AppException, ErrorCodes } from '../common/errors';
import { clientIpFor, resolveClientIpHeader } from '../common/client-ip';
import { MetricsService } from '../metrics/metrics.service';
import { HumanCheckRisk } from './human-check-risk';
import {
  HUMAN_CHECK_ACTIONS,
  assertHumanCheckSettings,
  humanCheckSettings,
  type HumanCheckAction,
  type HumanCheckSettings,
} from './human-check.settings';
import { verifyTurnstileToken, type FetchLike } from './turnstile-verifier';

/**
 * The header a solved Turnstile token travels in.
 *
 * A header and not a body field so the check is the same on every route whatever its body
 * schema is (the Zod schemas are strict and would refuse an unknown field), and so the shared
 * web client can add it on a retry without knowing what the request was.
 */
export const HUMAN_CHECK_HEADER = 'x-turnstile-token';

/**
 * Decides, for one request to a decorated route, whether it may go on.
 *
 * The answers a client can get, and what each one is for:
 *   428 HUMAN_CHECK_REQUIRED     no token, and one is needed. `details` carries the action and
 *                                the public site key, so the client can draw the widget and send
 *                                the request again with the token. Nothing has happened yet.
 *   403 HUMAN_CHECK_FAILED       a token was sent and it does not prove anything here: forged,
 *                                spent, solved on another site or for another form, or too old.
 *                                Same `details`, so the client can ask for a fresh one.
 *   503 HUMAN_CHECK_UNAVAILABLE  Cloudflare could not answer and this route fails closed.
 */
@Injectable()
export class HumanCheckService {
  private readonly logger = new Logger(HumanCheckService.name);
  readonly settings: HumanCheckSettings;
  private readonly ipHeader: string | null;
  private fetchImpl: FetchLike | undefined;

  constructor(
    config: ConfigService,
    private readonly risk: HumanCheckRisk,
    private readonly metrics: MetricsService,
  ) {
    this.settings = humanCheckSettings(config);
    // Refuses to boot with a switched-on check that has no keys (see the settings file).
    assertHumanCheckSettings(this.settings, config.get<string>('APP_ENV'));
    // The same client address the throttle counts, so the two can never disagree about who.
    this.ipHeader = resolveClientIpHeader({
      THROTTLE_CLIENT_IP_HEADER: config.get<string>('THROTTLE_CLIENT_IP_HEADER'),
      RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID,
    });
  }

  /** Tests only: answer siteverify from a stub. */
  useFetch(fetchImpl: FetchLike): void {
    this.fetchImpl = fetchImpl;
  }

  async enforce(action: HumanCheckAction, req: Request): Promise<true> {
    const { settings } = this;
    if (settings.mode === 'off') return true;

    const ip = clientIpFor(req, this.ipHeader);
    const policy = HUMAN_CHECK_ACTIONS[action];

    if (settings.mode === 'adaptive') {
      const limit =
        policy.tier === 'strict' ? settings.adaptiveStrictLimit : settings.adaptiveLenientLimit;
      const attempts = await this.risk.hit(action, ip, settings.adaptiveWindowSeconds);
      if (attempts <= limit) {
        this.metrics.recordHumanCheck(action, 'not_required');
        return true;
      }
    }

    const raw = req.headers[HUMAN_CHECK_HEADER];
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (!token) {
      this.metrics.recordHumanCheck(action, 'required');
      throw new AppException(
        ErrorCodes.HUMAN_CHECK_REQUIRED,
        'Please confirm you are a person, then try again.',
        HttpStatus.PRECONDITION_REQUIRED,
        this.challengeDetails(action),
      );
    }

    const outcome = await verifyTurnstileToken({
      token,
      remoteIp: ip,
      expectedAction: action,
      settings,
      fetchImpl: this.fetchImpl,
    });

    if (outcome.ok) {
      this.metrics.recordHumanCheck(action, 'passed');
      return true;
    }

    if (outcome.kind === 'failed') {
      this.metrics.recordHumanCheck(action, `failed_${outcome.reason}`);
      throw new AppException(
        ErrorCodes.HUMAN_CHECK_FAILED,
        'We could not confirm you are a person. Please try the check again.',
        HttpStatus.FORBIDDEN,
        this.challengeDetails(action),
      );
    }

    const failOpen = settings.failOpenOverride ?? policy.failOpen;
    // The reason is a fixed word (timeout, network, ...). Never the token, never the secret.
    this.logger.warn(
      `Turnstile could not answer (${outcome.reason}) on ${action}; ` +
        (failOpen ? 'request allowed (fails open).' : 'request refused (fails closed).'),
    );
    this.metrics.recordHumanCheck(action, failOpen ? 'unavailable_open' : 'unavailable_closed');
    if (failOpen) return true;
    throw new AppException(
      ErrorCodes.HUMAN_CHECK_UNAVAILABLE,
      'We cannot check this request right now. Please try again in a few minutes.',
      HttpStatus.SERVICE_UNAVAILABLE,
      { action },
    );
  }

  private challengeDetails(action: HumanCheckAction): Record<string, unknown> {
    return { action, siteKey: this.settings.siteKey };
  }
}
