import { FailureClass, failureClassForStatus, isRetryableFailure } from '@eticketsgo/shared-types';

/**
 * The small amount of HTTP a messaging provider needs, and the error classification the
 * retry loop needs back.
 *
 * ── WHY NOT REUSE THE PAYMENT REST CLIENT ──────────────────────────────────────────
 * `payments/provider/rest-client.ts` does exactly this shape of work, and it throws
 * `PaymentProviderError`. Importing that into notifications would put payment error codes on
 * a failed SMS and make a notification failure indistinguishable from a payment failure in
 * every dashboard and alert that groups by error type. The forty lines are cheaper than that
 * confusion; the classification rules below are deliberately identical.
 */

/**
 * A provider refused, could not be reached, or was never configured.
 *
 * -- WHY THIS CARRIES A CLASS AND NOT A BOOLEAN ------------------------------------
 * It used to carry `retryable: boolean`, which is the one bit the retry loop needs and the
 * only bit anything recorded. Everything else about the failure was in the message string,
 * so a missing MSG91 auth key, an unapproved DLT template, a dead phone number and Twilio
 * being down were four rows that differed only in prose -- and all four were filed against
 * the provider's reliability.
 *
 * The class is the fact; `retryable` is now DERIVED from it. That ordering matters: a future
 * adapter cannot mark a missing credential retryable, because retryability is no longer
 * something a call site gets to assert.
 */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly failureClass: FailureClass,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }

  /** Derived, never asserted. See the class comment. */
  get retryable(): boolean {
    return isRetryableFailure(this.failureClass);
  }
}

export interface TransportRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** 5xx and transport failures are worth another attempt; 4xx is a bug or a bad credential. */
export function isRetryableStatus(status: number): boolean {
  // 429 is a rate limit: the request was fine, there was just too much of it.
  return status >= 500 || status === 429;
}

/**
 * POST/GET JSON with a hard timeout, returning the parsed body.
 *
 * A provider that hangs must not hold a worker slot indefinitely — the sweep runs every few
 * seconds and a stuck socket would silently reduce throughput to nothing.
 */
export async function transportJson<T>(
  provider: string,
  url: string,
  opts: TransportRequest = {},
): Promise<{ status: number; data: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new TransportError(
      aborted ? `${provider} request timed out` : `${provider} could not be reached`,
      provider,
      FailureClass.TEMPORARY_PROVIDER_ERROR,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let data: T;
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    data = {} as T;
  }
  if (!res.ok) {
    /*
      The provider's own message is included because it is the only thing that says WHY —
      "template not approved", "sender id not registered". It goes into `Notification.lastError`,
      which is read by an operator and never shown to a customer. Credentials are in headers,
      never in a response body, so this cannot echo one back.
    */
    const detail = summarise(text);
    throw new TransportError(
      `${provider} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      provider,
      /*
        The status is the starting point, not the answer. Most providers say 400 for both a
        bad template and a bad number, so an adapter that can tell them apart catches this
        and rethrows with the narrower class.
      */
      failureClassForStatus(res.status),
      res.status,
    );
  }
  return { status: res.status, data };
}

/** First 300 characters of a response body, so one bad request cannot fill a log file. */
function summarise(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
