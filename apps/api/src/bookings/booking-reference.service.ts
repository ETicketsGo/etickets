import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Generates human-readable, globally-unique, immutable booking references of the
 * form `ETG-<COUNTRY>-<YEAR>-<SEQUENCE>` (e.g. `ETG-IND-2026-000001`).
 *
 * - **Country-aware:** ISO-3166 alpha-3 derived from the booking's venue country
 *   (falls back to `INT` for anything not yet mapped — supports new regions).
 * - **Year-aware:** the confirmation year.
 * - **Collision-free:** the sequence comes from an atomic per-(country, year)
 *   counter incremented inside the confirm transaction, so concurrent
 *   confirmations and multi-region deployments never clash.
 * - **Immutable:** assigned once at confirmation and never rewritten.
 */
@Injectable()
export class BookingReferenceService {
  static readonly BRAND = 'ETG';

  /** Country name (as stored on Venue) → ISO-3166 alpha-3. Extend per new market. */
  private static readonly COUNTRY_ALPHA3: Record<string, string> = {
    india: 'IND',
    'united states': 'USA',
    'united states of america': 'USA',
    usa: 'USA',
    us: 'USA',
    canada: 'CAN',
    'united kingdom': 'GBR',
    uk: 'GBR',
    'great britain': 'GBR',
    australia: 'AUS',
    'united arab emirates': 'ARE',
    uae: 'ARE',
    singapore: 'SGP',
  };

  /** Maps a free-text country to a 3-letter code; `INT` when unknown. */
  countryCode(country?: string | null): string {
    if (!country) return 'INT';
    return BookingReferenceService.COUNTRY_ALPHA3[country.trim().toLowerCase()] ?? 'INT';
  }

  /**
   * Atomically reserves the next reference for `country`/`at`'s year using the
   * per-scope counter. Must run inside the confirm transaction so the number is
   * never handed out twice.
   */
  async assign(
    tx: Prisma.TransactionClient,
    opts: { country?: string | null; at: Date },
  ): Promise<string> {
    const code = this.countryCode(opts.country);
    const year = opts.at.getUTCFullYear();
    const scope = `${code}-${year}`;
    const counter = await tx.bookingReferenceCounter.upsert({
      where: { scope },
      create: { scope, value: 1 },
      update: { value: { increment: 1 } },
    });
    // Zero-pad to 6 for readability; longer sequences simply grow (no truncation).
    const seq = String(counter.value).padStart(6, '0');
    return `${BookingReferenceService.BRAND}-${code}-${year}-${seq}`;
  }
}
