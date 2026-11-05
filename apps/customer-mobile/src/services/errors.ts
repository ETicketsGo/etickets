import { AxiosError } from 'axios';
import { ApiContractError } from './http';

// Re-exported so callers have one obvious place to reach for error helpers, while the
// predicate itself stays in a dependency-free module. See network-error.ts.
export { isUnreachable } from './network-error';

/**
 * Turn any thrown value into something worth showing a customer.
 *
 * The API returns a structured `{ code, message, details, correlationId }` and its
 * messages are already written for end users ("Booking cancellation is not available"),
 * so those are surfaced verbatim. Everything else gets a plain sentence — an axios
 * stack or a raw status code tells the user nothing they can act on.
 */
export function messageForError(error: unknown): string {
  if (error instanceof ApiContractError) {
    return 'This version of the app could not understand the response. Please update to the latest version.';
  }

  if (error instanceof AxiosError) {
    // No response at all: DNS, timeout, aeroplane mode, captive wifi.
    if (!error.response) {
      return error.code === 'ECONNABORTED'
        ? 'That took too long. Check your connection and try again.'
        : "We couldn't reach ETicketsGo. Check your connection and try again.";
    }

    const body = error.response.data as { message?: unknown; code?: unknown } | undefined;
    // The server words these for the website, which can draw a check to solve. The app cannot,
    // so it says what the person can actually do. See services/human-check.ts.
    if (body?.code === 'HUMAN_CHECK_REQUIRED' || body?.code === 'HUMAN_CHECK_FAILED') {
      return 'We could not confirm this request came from the ETicketsGo app on this phone. Update Google Play services and try again, or use the website.';
    }
    if (body?.code === 'HUMAN_CHECK_UNAVAILABLE') {
      return 'We cannot check this request right now. Please try again in a few minutes.';
    }
    if (typeof body?.message === 'string' && body.message.trim()) return body.message;

    switch (error.response.status) {
      case 401:
        return 'Please sign in again.';
      case 403:
        return "You don't have permission to do that.";
      case 404:
        return "We couldn't find that.";
      case 409:
        return 'Someone got there first. Please try again.';
      case 429:
        return "That's a lot of requests. Wait a moment and try again.";
      default:
        return error.response.status >= 500
          ? 'Something went wrong on our side. Please try again shortly.'
          : 'Something went wrong. Please try again.';
    }
  }

  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}
