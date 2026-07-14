import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';

/**
 * Minimal JSON-over-HTTP helper shared by the fetch-based provider adapters
 * (PayPal, Square). Uses the platform global `fetch` (no SDK dependency), applies
 * an AbortController timeout, and normalizes transport/HTTP failures into
 * PaymentProviderError so the orchestrator can reason about retryability:
 *   401/403 → AUTHENTICATION_FAILED (terminal)
 *   4xx     → INVALID_REQUEST      (terminal)
 *   5xx     → PROVIDER_UNAVAILABLE (retryable)
 *   network/abort → PROVIDER_TIMEOUT/PROVIDER_UNAVAILABLE (retryable)
 */
export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface JsonResponse<T> {
  status: number;
  data: T;
}

function classify(status: number): PaymentErrorCode {
  if (status === 401 || status === 403) return PaymentErrorCode.AUTHENTICATION_FAILED;
  if (status >= 500) return PaymentErrorCode.PROVIDER_UNAVAILABLE;
  return PaymentErrorCode.INVALID_REQUEST;
}

export async function requestJson<T>(
  provider: string,
  url: string,
  opts: RequestOptions = {},
): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    throw new PaymentProviderError(
      aborted ? PaymentErrorCode.PROVIDER_TIMEOUT : PaymentErrorCode.PROVIDER_UNAVAILABLE,
      aborted ? `${provider} request timed out.` : `${provider} request failed to connect.`,
      provider,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  if (!res.ok) {
    const message =
      (data as { message?: string; error_description?: string })?.message ??
      (data as { error_description?: string })?.error_description ??
      `${provider} returned HTTP ${res.status}`;
    throw new PaymentProviderError(classify(res.status), message, provider, data);
  }
  return { status: res.status, data };
}

/** ISO-4217 minor-unit exponent for currencies that are not the default of 2. */
const ZERO_DECIMAL = new Set([
  'JPY',
  'KRW',
  'VND',
  'CLP',
  'ISK',
  'XOF',
  'XAF',
  'PYG',
  'RWF',
  'UGX',
]);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'TND', 'JOD', 'IQD', 'LYD']);

/** Exponent (number of minor digits) for an ISO-4217 currency code. */
export function currencyExponent(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Format integer minor units as a decimal string (e.g. 1050 USD → "10.50"). */
export function minorToDecimalString(amountMinor: number, currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return String(amountMinor);
  const s = Math.abs(amountMinor)
    .toString()
    .padStart(exp + 1, '0');
  const whole = s.slice(0, s.length - exp);
  const frac = s.slice(s.length - exp);
  const sign = amountMinor < 0 ? '-' : '';
  return `${sign}${whole}.${frac}`;
}
