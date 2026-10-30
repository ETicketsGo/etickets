import { createHash } from 'node:crypto';

/** The fields of a stored band that decide what it charges and where. */
export interface FingerprintBand {
  id: string;
  minMinor: number;
  maxMinor: number | null;
  feeMinor: number;
  feeType?: string | null;
  feePercentBps?: number | null;
  minFeeMinor?: number | null;
  maxFeeMinor?: number | null;
  country: string;
  region: string;
  active: boolean;
}

/**
 * A short, stable fingerprint of a fee schedule: the same bands give the same string, any change
 * to what a band charges or where gives another.
 *
 * Used twice. A quote carries the fingerprint of the bands that priced it, so a booking made
 * from that quote can refuse when the schedule changed in between instead of silently charging a
 * different fee. A draft remembers the fingerprint of the live bands it was copied from, so a
 * publish can refuse when somebody else changed the live schedule in the meantime (no lost update).
 */
export function scheduleFingerprint(bands: readonly FingerprintBand[]): string {
  const rows = [...bands]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((b) => [
      b.id,
      b.minMinor,
      b.maxMinor,
      b.feeMinor,
      b.feeType ?? 'FLAT',
      b.feePercentBps ?? null,
      b.minFeeMinor ?? null,
      b.maxFeeMinor ?? null,
      b.country,
      b.region,
      b.active,
    ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}
