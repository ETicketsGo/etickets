import { AxiosError } from 'axios';
import { ApiContractError } from './http';

/**
 * Turn any thrown value into something worth showing a customer.
 *
 * The API returns a structured `{ code, message, details, correlationId }` and its
 * messages are already written for end users ("Booking cancellation is not available"),
 * so those are surfaced verbatim. Everything else gets a plain sentence — an axios
 * stack or a raw status code tells the user nothing they can act on.
 */
/**
 * Whether the server never answered, as opposed to answering with a refusal.
 *
 * The difference decides whether a session is destroyed. "401, your token is dead" and
 * "aeroplane mode" both surface as a thrown error, and treating them alike is what made
 * the app delete a perfectly good refresh token every time it launched without signal —
 * which is precisely when its cached tickets were needed. Only the server may end a
 * session; the network may not.
 */
export function isUnreachable(error: unknown): boolean {
  return error instanceof AxiosError && !error.response;
}

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
    if (typeof body?.message === 'string' && body.message.trim()) return body.message;

    switch (error.response.status) {
      case 401:
        return 'Please sign in again.';
      case 403:
        return "You don't have permission to do that.";
      case 404:
        return "We couldn't find that.";
      case 409:
        return 'Someone got there first — please try again.';
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
