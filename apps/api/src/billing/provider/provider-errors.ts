import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';

/**
 * The provider could not be reached or refused for a reason of its own. 502: the request was
 * fine, the upstream was not. The webhook processor treats this as TRANSIENT and retries it;
 * a 4xx AppException is a decision and is recorded as FAILED.
 */
export function providerUnavailable(message: string): AppException {
  return new AppException(ErrorCodes.BILLING_PROVIDER_UNAVAILABLE, message, HttpStatus.BAD_GATEWAY);
}

/** A capability this provider account does not have (e.g. Subscriptions or UPI Autopay off). */
export function capabilityMissing(message: string): AppException {
  return new AppException(ErrorCodes.BILLING_PROVIDER_UNAVAILABLE, message, HttpStatus.CONFLICT);
}

export function isTransientBillingError(err: unknown): boolean {
  if (err instanceof AppException) return err.getStatus() >= 500;
  return true;
}
