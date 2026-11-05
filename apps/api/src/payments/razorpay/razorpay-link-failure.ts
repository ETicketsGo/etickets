import { HttpStatus, type Logger } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';
import { currentRequest } from '../../common/request-context';

/** The sentence for every "this server cannot use Razorpay" cause. Names no provider. */
export const RAZORPAY_NOT_CONFIGURED_MESSAGE =
  'Payout setup is not switched on for this site yet. Contact ETicketsGo support.';

export const RAZORPAY_ACCOUNT_NOT_FOUND_MESSAGE =
  'We could not find that Razorpay linked account. Check the account ID (acc_...) and try again.';

/*
  Razorpay descriptions that mean "this id is not an account you can read". A fetch of
  GET /v1/accounts/:id carries nothing but the id, so a 400/404 about the id is the
  organizer's typo or someone else's account, never our setup.
*/
const ACCOUNT_NOT_FOUND =
  /does not exist|not found|no such|invalid (account )?id|is not a valid id|not accessible|access denied|not linked|is invalid/i;
/*
  Descriptions that mean OUR Razorpay account cannot do this at all: Route (linked accounts)
  not enabled, or the endpoint not available to our account. Checked before ACCOUNT_NOT_FOUND
  because Razorpay answers a disabled feature with "The requested URL was not found on the
  server", which would otherwise read as a missing account.
*/
const PLATFORM_NOT_ENABLED =
  /requested url was not found|not enabled|feature is not|not activated|not allowed for this merchant/i;

/** A missing-key construction failure from the adapter (`Razorpay requires X to be set`). */
export function isMissingCredential(err: unknown): boolean {
  return err instanceof Error && /requires [A-Z0-9_]+ to be set/.test(err.message);
}

export function razorpayNotConfigured(): AppException {
  return new AppException(
    ErrorCodes.PAYMENT_PROVIDER_NOT_CONFIGURED,
    RAZORPAY_NOT_CONFIGURED_MESSAGE,
    HttpStatus.SERVICE_UNAVAILABLE,
    { retryable: false },
  );
}

/**
 * A Razorpay failure while linking an organizer's account, as a refusal the organizer can act on.
 *
 * Linking used to let the SDK rejection through untouched: the SDK rejects with a plain
 * `{ statusCode, error: { code, description } }` object, which the exception filter turned
 * into a 500 "Something went wrong." for every refusal - a mistyped acc_ id included.
 * Razorpay's own words go to the log with the correlation id, never to the organizer.
 */
export function razorpayLinkFailure(err: unknown, logger: Logger): AppException {
  if (err instanceof AppException) return err;
  if (isMissingCredential(err)) {
    logger.error(
      `Razorpay payout setup is not configured on this server: ${(err as Error).message}`,
    );
    return razorpayNotConfigured();
  }

  const e = (err ?? {}) as {
    statusCode?: unknown;
    error?: { code?: unknown; description?: unknown };
    message?: unknown;
    code?: unknown;
  };
  const status = typeof e.statusCode === 'number' ? e.statusCode : 0;
  const code = typeof e.error?.code === 'string' ? e.error.code : '';
  const description =
    typeof e.error?.description === 'string'
      ? e.error.description
      : typeof e.message === 'string'
        ? e.message
        : 'unknown error';
  const ref = currentRequest()?.correlationId;
  logger.error(
    `Razorpay refused to fetch a linked account: [${status || 'no status'}${code ? ` ${code}` : ''}]${ref ? ` correlationId=${ref}` : ''} ${description.slice(0, 500)}`,
  );

  if (status === 401) return razorpayNotConfigured();
  if (status >= 400 && status < 500 && status !== 429) {
    if (PLATFORM_NOT_ENABLED.test(description)) return razorpayNotConfigured();
    if (status === 400 || status === 404 || ACCOUNT_NOT_FOUND.test(description)) {
      return new AppException(
        ErrorCodes.PAYOUT_ACCOUNT_NOT_FOUND,
        RAZORPAY_ACCOUNT_NOT_FOUND_MESSAGE,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    // 403 and other refusals of OUR request: our account's setup, not the organizer's input.
    return razorpayNotConfigured();
  }
  // 429, 5xx, a network failure (no status at all) or anything unforeseen: try again later.
  return new AppException(
    ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
    'The payout provider is not answering right now. Try again in a few minutes.',
    HttpStatus.SERVICE_UNAVAILABLE,
    { retryable: true },
  );
}
