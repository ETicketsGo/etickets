import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { GoogleAuth } from 'google-auth-library';
import { AppException, ErrorCodes } from '../common/errors';
import { clientIpFor, resolveClientIpHeader } from '../common/client-ip';
import { MetricsService } from '../metrics/metrics.service';
import { HumanCheckRisk } from './human-check-risk';
import {
  HUMAN_CHECK_ACTIONS,
  assertHumanCheckSettings,
  assertPlayIntegritySettings,
  humanCheckSettings,
  type HumanCheckAction,
  type HumanCheckSettings,
} from './human-check.settings';
import { verifyTurnstileToken, type FetchLike } from './turnstile-verifier';
import {
  PLAY_INTEGRITY_NONCE,
  PLAY_INTEGRITY_SCOPE,
  playIntegrityRequestHash,
  verifyPlayIntegrityToken,
  type AccessTokenProvider,
} from './play-integrity-verifier';

/**
 * The header a solved Turnstile token travels in.
 *
 * A header and not a body field so the check is the same on every route whatever its body
 * schema is (the Zod schemas are strict and would refuse an unknown field), and so the shared
 * web client can add it on a retry without knowing what the request was.
 */
export const HUMAN_CHECK_HEADER = 'x-turnstile-token';

/**
 * The Android app's proof instead: a Play Integrity token, the random nonce its request hash
 * was built from, and the application id it was minted for (production or the preview build).
 * See play-integrity-verifier.ts. All three or none.
 */
export const PLAY_INTEGRITY_HEADER = 'x-play-integrity-token';
export const PLAY_INTEGRITY_NONCE_HEADER = 'x-play-integrity-nonce';
export const PLAY_INTEGRITY_PACKAGE_HEADER = 'x-play-integrity-package';

type Outcome = { ok: true } | { ok: false; kind: 'failed' | 'unavailable'; reason: string };

function header(req: Request, name: string): string {
  const raw = req.headers[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

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
  private accessTokenImpl: AccessTokenProvider | undefined;
  private googleAuth: GoogleAuth | undefined;

  constructor(
    config: ConfigService,
    private readonly risk: HumanCheckRisk,
    private readonly metrics: MetricsService,
  ) {
    this.settings = humanCheckSettings(config);
    // Refuses to boot with a switched-on check that has no keys (see the settings file).
    assertHumanCheckSettings(this.settings, config.get<string>('APP_ENV'));
    assertPlayIntegritySettings(config, this.settings, config.get<string>('APP_ENV'));
    // The same client address the throttle counts, so the two can never disagree about who.
    this.ipHeader = resolveClientIpHeader({
      THROTTLE_CLIENT_IP_HEADER: config.get<string>('THROTTLE_CLIENT_IP_HEADER'),
      RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID,
    });
  }

  /** Tests only: answer siteverify (and Play's decode) from a stub. */
  useFetch(fetchImpl: FetchLike): void {
    this.fetchImpl = fetchImpl;
  }

  /** Tests only: an access token without signing a JWT for Google. */
  useAccessToken(provider: AccessTokenProvider): void {
    this.accessTokenImpl = provider;
  }

  /** The service account's OAuth token for the Play Integrity API (google-auth-library caches it). */
  private readonly accessToken: AccessTokenProvider = async () => {
    if (this.accessTokenImpl) return this.accessTokenImpl();
    const pi = this.settings.playIntegrity;
    if (!pi) throw new Error('Play Integrity is not configured.');
    this.googleAuth ??= new GoogleAuth({
      credentials: JSON.parse(pi.serviceAccountJson) as {
        client_email: string;
        private_key: string;
      },
      scopes: [PLAY_INTEGRITY_SCOPE],
    });
    const token = await this.googleAuth.getAccessToken();
    if (!token) throw new Error('No access token.');
    return token;
  };

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

    // The Android app: a Play Integrity token, when this environment can decode one.
    const playToken = header(req, PLAY_INTEGRITY_HEADER);
    if (playToken && settings.playIntegrity) {
      const outcome = await this.checkPlayIntegrity(action, req, playToken);
      return this.settle(action, 'Play Integrity', 'pi_', outcome);
    }

    const token = header(req, HUMAN_CHECK_HEADER);
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
    return this.settle(action, 'Turnstile', '', outcome);
  }

  private async checkPlayIntegrity(
    action: HumanCheckAction,
    req: Request,
    token: string,
  ): Promise<Outcome> {
    const nonce = header(req, PLAY_INTEGRITY_NONCE_HEADER);
    if (!PLAY_INTEGRITY_NONCE.test(nonce)) return { ok: false, kind: 'failed', reason: 'invalid' };
    // Claimed BEFORE Google is asked, so two requests racing with one token cannot both pass.
    // Kept a minute past the token's own age limit, after which the verdict is refused anyway.
    const fresh = await this.risk.claimOnce(
      'play-integrity',
      nonce,
      this.settings.maxTokenAgeSeconds + 60,
    );
    if (!fresh) return { ok: false, kind: 'failed', reason: 'replay' };
    return verifyPlayIntegrityToken({
      token,
      packageName: header(req, PLAY_INTEGRITY_PACKAGE_HEADER),
      expectedRequestHash: playIntegrityRequestHash(action, nonce),
      settings: this.settings,
      accessToken: this.accessToken,
      fetchImpl: this.fetchImpl,
    });
  }

  /** One outcome, from either provider, to "go on" or the answer the client is owed. */
  private settle(
    action: HumanCheckAction,
    provider: string,
    metricPrefix: string,
    outcome: Outcome,
  ): true {
    if (outcome.ok) {
      this.metrics.recordHumanCheck(action, `${metricPrefix}passed`);
      return true;
    }

    if (outcome.kind === 'failed') {
      this.metrics.recordHumanCheck(action, `${metricPrefix}failed_${outcome.reason}`);
      throw new AppException(
        ErrorCodes.HUMAN_CHECK_FAILED,
        'We could not confirm you are a person. Please try the check again.',
        HttpStatus.FORBIDDEN,
        this.challengeDetails(action),
      );
    }

    const failOpen = this.settings.failOpenOverride ?? HUMAN_CHECK_ACTIONS[action].failOpen;
    // The reason is a fixed word (timeout, network, ...). Never the token, never the secret.
    this.logger.warn(
      `${provider} could not answer (${outcome.reason}) on ${action}; ` +
        (failOpen ? 'request allowed (fails open).' : 'request refused (fails closed).'),
    );
    this.metrics.recordHumanCheck(
      action,
      `${metricPrefix}${failOpen ? 'unavailable_open' : 'unavailable_closed'}`,
    );
    if (failOpen) return true;
    throw new AppException(
      ErrorCodes.HUMAN_CHECK_UNAVAILABLE,
      'We cannot check this request right now. Please try again in a few minutes.',
      HttpStatus.SERVICE_UNAVAILABLE,
      { action },
    );
  }

  private challengeDetails(action: HumanCheckAction): Record<string, unknown> {
    const pi = this.settings.playIntegrity;
    // What the Android app needs to answer: Play's cloud project number (public, like the site key).
    return {
      action,
      siteKey: this.settings.siteKey,
      playIntegrity: pi ? { cloudProjectNumber: pi.cloudProjectNumber } : null,
    };
  }
}
