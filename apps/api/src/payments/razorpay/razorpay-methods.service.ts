import { Injectable, Logger } from '@nestjs/common';

/** How long a successful answer is trusted before the account is asked again. */
export const METHODS_TTL_MS = 10 * 60_000;
/** How long a FAILED lookup is remembered, so an outage does not add 3s to every payment. */
export const METHODS_FAILURE_TTL_MS = 60_000;
/** The lookup sits in front of opening Checkout, so it must never hold a buyer up for long. */
export const METHODS_TIMEOUT_MS = 3_000;

const PREFERENCES_URL = 'https://api.razorpay.com/v1/preferences';

interface CacheEntry {
  upi: boolean;
  expiresAt: number;
}

/**
 * Which payment methods the platform Razorpay account actually offers.
 *
 * ── WHY ASK THE ACCOUNT ────────────────────────────────────────────────────────────
 * The storefront puts "Pay by any UPI App" (QR on desktop, intent on mobile) first in
 * Checkout, the way Indian buyers expect. But UPI is a per-account switch in the Razorpay
 * dashboard, and the QA account has it OFF. A UPI block pinned to the top of Checkout on an
 * account without UPI is an empty or broken first option — worse than no block at all.
 *
 * `GET /v1/preferences?key_id=…` is the public, unauthenticated preflight Checkout itself
 * calls before drawing its method list, so its `methods.upi` is exactly what the buyer
 * would be offered. Only the PUBLIC key id is sent; the secret is never involved.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────────────
 * Any failure — HTTP error, network error, timeout, an unexpected body — answers "UPI not
 * known to be enabled". The page then opens Checkout with Razorpay's default method list,
 * which is exactly how it behaved before this existed. This method never rejects.
 *
 * When somebody turns UPI on in the dashboard, the block appears on its own once the cached
 * answer expires (at most METHODS_TTL_MS) — no deploy and no configuration change.
 */
@Injectable()
export class RazorpayMethodsService {
  private readonly logger = new Logger(RazorpayMethodsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  /** True only when the account positively reports UPI as enabled for this currency. */
  async upiEnabled(keyId: string, currency = 'INR'): Promise<boolean> {
    const cacheKey = `${keyId}:${currency.toUpperCase()}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.upi;

    // Concurrent payments share one lookup rather than each asking Razorpay.
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const lookup = this.lookup(keyId, currency.toUpperCase())
      .then(({ upi, ok }) => {
        this.cache.set(cacheKey, {
          upi,
          expiresAt: Date.now() + (ok ? METHODS_TTL_MS : METHODS_FAILURE_TTL_MS),
        });
        return upi;
      })
      .finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, lookup);
    return lookup;
  }

  private async lookup(keyId: string, currency: string): Promise<{ upi: boolean; ok: boolean }> {
    const url = `${PREFERENCES_URL}?key_id=${encodeURIComponent(keyId)}&currency=${encodeURIComponent(currency)}`;
    const controller = new AbortController();
    // Covers the body read too: the timer is only cleared once the JSON has been parsed.
    const timer = setTimeout(() => controller.abort(), METHODS_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return this.failed(`HTTP ${res.status}`);
      const upi = readUpi(await res.json());
      if (upi === undefined) return this.failed('the response had no boolean methods.upi');
      return { upi, ok: true };
    } catch (err) {
      /*
        Only the error's NAME and code are logged, never its message: a transport error can
        echo the request URL, and the URL carries the key id.
      */
      const aborted = err instanceof Error && err.name === 'AbortError';
      const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
      return this.failed(
        aborted
          ? `timed out after ${METHODS_TIMEOUT_MS}ms`
          : `request failed (${err instanceof Error ? err.name : 'unknown error'}${
              typeof code === 'string' ? ` ${code}` : ''
            })`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private failed(reason: string): { upi: boolean; ok: boolean } {
    this.logger.warn(
      `Razorpay payment-method lookup failed: ${reason}. Checkout opens with the default methods and no UPI block.`,
    );
    return { upi: false, ok: false };
  }
}

/** `methods.upi` when it is a boolean; undefined for any other shape. */
function readUpi(body: unknown): boolean | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const methods = (body as { methods?: unknown }).methods;
  if (typeof methods !== 'object' || methods === null) return undefined;
  const upi = (methods as { upi?: unknown }).upi;
  return typeof upi === 'boolean' ? upi : undefined;
}
