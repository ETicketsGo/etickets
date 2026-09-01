import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AppException, ErrorCodes } from './errors';

/**
 * Where to send somebody who is leaving this API and coming back.
 *
 * ── THE RECURRING BUG THIS EXISTS TO END ───────────────────────────────────────────
 * Five variables on this platform have shipped a `http://localhost:…` default, and every
 * one of them failed silently in a deployed environment, because a default is not a
 * missing value — nothing is unset, so nothing complains:
 *
 *   1. `ORGANIZER_WEB_URL`      dead invite links on QA for an hour
 *   2. the password-reset link  a reset that could not be opened
 *   3. `RAZORPAY_CALLBACK_URL`  a paying customer returned to a laptop, AFTER the money moved
 *   4. `STRIPE_SUCCESS_URL`     the same thing, waiting for the first Stripe key
 *   5. `STRIPE_CONNECT_*`       an organizer sent to localhost mid-onboarding
 *
 * The first three were found in production-shaped environments, one of them by a paying
 * customer's redirect. The last two were found by reading, before Stripe was configured,
 * which is the only reason they are cheap.
 *
 * So the rule, applied here rather than repeated at each call site: a URL a human will be
 * redirected to is DERIVED from the one variable that already knows where that site lives,
 * and if that is unset the request FAILS LOUDLY outside local development. An explicit
 * override stays available for the case derivation cannot cover — a return path that must
 * land somewhere other than the obvious site.
 */

/** Which site a person is being returned to. Each has one variable that knows its origin. */
type Site = 'customer' | 'organizer';

const SITE_VARIABLE: Record<Site, string> = {
  customer: 'CUSTOMER_WEB_URL',
  organizer: 'ORGANIZER_WEB_URL',
};

/** Only ever used when APP_ENV says this is a developer's machine. */
const LOCAL_ORIGIN: Record<Site, string> = {
  customer: 'http://localhost:3000',
  organizer: 'http://localhost:3001',
};

export interface RedirectUrlOptions {
  /** The variable a deployment may set to override the derivation entirely. */
  overrideVariable: string;
  /** Which site the person is going back to. */
  site: Site;
  /** Path on that site, with a leading slash. */
  path: string;
  /** Appended verbatim — for provider placeholders like `{CHECKOUT_SESSION_ID}`. */
  query?: string;
  /** Named in the error, so the message says which journey broke. */
  purpose: string;
}

export function redirectUrl(config: ConfigService, options: RedirectUrlOptions): string {
  const explicit = config.get<string>(options.overrideVariable)?.trim();
  if (explicit) return explicit;

  const variable = SITE_VARIABLE[options.site];
  const origin = config.get<string>(variable)?.trim();
  const suffix = `${options.path}${options.query ? `?${options.query}` : ''}`;
  if (origin) return `${origin.replace(/\/+$/, '')}${suffix}`;

  const appEnv = config.get<string>('APP_ENV') ?? 'LOCAL';
  /*
    APP_ENV, not NODE_ENV. QA and UAT both run with NODE_ENV=production, so a guard keyed
    on NODE_ENV would treat them as production — which is right here by luck, but has been
    wrong elsewhere on this platform often enough to be worth stating.
  */
  if (['LOCAL', 'DEV'].includes(appEnv)) return `${LOCAL_ORIGIN[options.site]}${suffix}`;

  throw new AppException(
    ErrorCodes.INTERNAL,
    `Cannot build the ${options.purpose} URL: neither ${variable} nor ${options.overrideVariable} ` +
      `is set, so the person would be sent to localhost.`,
    HttpStatus.INTERNAL_SERVER_ERROR,
    { appEnv, purpose: options.purpose },
  );
}
