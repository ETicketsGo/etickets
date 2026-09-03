import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCodes } from '../../common/errors';
import type { TaxLine } from '../../pricing/tax-calculator';
import type { TaxProvider, TaxQuoteRequest, TaxQuoteResult } from '../tax-provider.interface';

/**
 * Tax from an external tax service.
 *
 * ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────────────
 * This is a working, vendor-neutral HTTP adapter and a deliberate PLACEHOLDER. It speaks
 * one small JSON contract — amounts in, itemised tax lines out — and expects a thin
 * translation layer in front of whichever vendor is chosen. It is not a Stripe Tax client
 * or an Avalara client, because writing one of those before the vendor is chosen would be
 * guessing at three APIs and shipping two of them dead.
 *
 * What it DOES give you is everything that has to be right regardless of vendor: the
 * fail-closed behaviour, the timeout, the refusal to guess, and the shape of the answer.
 * Swapping in a real vendor means editing `toVendorRequest`/`fromVendorResponse` and
 * nothing else.
 *
 * ── WHY IT FAILS CLOSED ────────────────────────────────────────────────────────────
 * If the tax service is unreachable there are two options: charge no tax, or refuse the
 * sale. Charging no tax silently under-collects on every order for the duration of the
 * outage, and the platform — not the customer — is liable for the difference. Refusing is
 * visible, bounded, and recoverable. So a failed lookup throws, and the checkout says so.
 *
 * The one exception is `TAX_EXTERNAL_FAIL_OPEN=true`, which exists because an owner may
 * decide that in their market the exposure from an outage is smaller than the exposure
 * from a dead checkout. That is their call to make explicitly, not ours to default.
 */
@Injectable()
export class ExternalTaxProvider implements TaxProvider {
  readonly name: string;
  private readonly logger = new Logger('ExternalTax');
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly failOpen: boolean;

  constructor(config: ConfigService) {
    // Names the vendor purely for the audit trail; the wire contract is the same.
    this.name = config.get<string>('TAX_EXTERNAL_VENDOR') ?? 'external';
    this.endpoint = required(config, 'TAX_EXTERNAL_ENDPOINT');
    this.apiKey = required(config, 'TAX_EXTERNAL_API_KEY');
    this.timeoutMs = Number(config.get<string>('TAX_EXTERNAL_TIMEOUT_MS') ?? 4000);
    this.failOpen = config.get<string>('TAX_EXTERNAL_FAIL_OPEN') === 'true';
  }

  async quote(request: TaxQuoteRequest): Promise<TaxQuoteResult> {
    // Bounded on purpose. A tax lookup sits in the checkout path, so an unbounded call
    // turns a vendor's bad day into a hung checkout for every buyer.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(toVendorRequest(request)),
        signal: abort.signal,
      });
      if (!res.ok) {
        // Body deliberately not logged: a tax request carries the buyer's location and the
        // amount they are paying, and the response may echo both.
        throw new Error(`tax service responded ${res.status}`);
      }
      return fromVendorResponse(this.name, await res.json());
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      if (this.failOpen) {
        this.logger.error(
          `tax lookup failed (${reason}); TAX_EXTERNAL_FAIL_OPEN is on, so this sale is ` +
            `proceeding with ZERO tax and will need reconciling.`,
        );
        return {
          taxLines: [],
          taxMinor: 0,
          taxAddedMinor: 0,
          provider: this.name,
          providerRef: null,
        };
      }
      this.logger.error(`tax lookup failed (${reason}); refusing the sale.`);
      throw new AppException(
        ErrorCodes.CONFLICT,
        'We could not calculate tax for this order. Please try again in a moment.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The vendor-neutral request. Replace when a vendor is chosen; nothing else changes. */
export function toVendorRequest(request: TaxQuoteRequest) {
  return {
    currency: request.context.currency,
    // Place of supply. An admission is taxed where the show is, not where the company is
    // registered — which is why the venue, and not the organization, fills these in.
    destination: {
      country: request.context.country ?? null,
      region: request.context.region ?? null,
      postalCode: request.context.postalCode ?? null,
    },
    sellerReference: request.context.organizationId ?? null,
    at: (request.context.at ?? new Date()).toISOString(),
    lines: [
      ...request.lines.map((l) => ({
        reference: l.reference,
        kind: l.kind,
        amountMinor: l.amountMinor,
      })),
      // The customer-borne fee is presented as its own line, because several jurisdictions
      // tax a booking fee differently from the admission it is charged on.
      ...(request.customerFeeMinor > 0
        ? [{ reference: 'booking-fee', kind: 'fee', amountMinor: request.customerFeeMinor }]
        : []),
    ],
  };
}

/**
 * Parse the vendor's answer, refusing anything it cannot fully understand.
 *
 * A malformed response is treated as a failure rather than as "no tax". Silently reading an
 * unparseable body as zero is the same under-collection the fail-closed rule exists to
 * prevent, arriving through a different door.
 */
export function fromVendorResponse(provider: string, body: unknown): TaxQuoteResult {
  const payload = body as { lines?: unknown; reference?: unknown };
  if (!Array.isArray(payload?.lines)) {
    throw new Error('tax service returned no line array');
  }
  const taxLines: TaxLine[] = payload.lines.map((raw, index) => {
    const l = raw as Partial<TaxLine>;
    if (
      typeof l.label !== 'string' ||
      !Number.isInteger(l.rateBasisPoints) ||
      !Number.isInteger(l.baseMinor) ||
      !Number.isInteger(l.amountMinor)
    ) {
      throw new Error(`tax service line ${index} is malformed`);
    }
    return {
      label: l.label,
      rateBasisPoints: l.rateBasisPoints as number,
      baseMinor: l.baseMinor as number,
      amountMinor: l.amountMinor as number,
      /*
        A vendor's line is tax owed ON an amount, added to it — the same reasoning as
        `taxAddedMinor` below. It is attributed to tickets because an external tax service is
        answering about the sale, not about our booking fee, which the request sends as its
        own line and which we do not currently ask a vendor to rate separately.
      */
      basis: 'TICKETS' as const,
      inclusive: false,
    };
  });
  const taxMinor = taxLines.reduce((sum, l) => sum + l.amountMinor, 0);
  return {
    taxLines,
    taxMinor,
    /*
      An external vendor's tax is ADDED to the total, in full.

      Inclusive pricing is an India/manual-rules concern: a vendor asked "what tax is owed
      on this amount" answers with tax owed ON it, not tax already inside it. Assuming
      otherwise would silently reduce what every customer of an external-tax deployment is
      charged, which is the wrong direction to be wrong in.
    */
    taxAddedMinor: taxMinor,
    provider,
    providerRef: typeof payload.reference === 'string' ? payload.reference : null,
  };
}

function required(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `TAX_PROVIDER=external requires ${key}. Configure your tax service, or set ` +
        `TAX_PROVIDER=manual to use the TaxRule table.`,
    );
  }
  return value;
}
