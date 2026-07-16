/**
 * Pure finance discrepancy detectors (ADR-029). Compare our records against
 * provider truth and internal invariants, producing discrepancy candidates. No
 * I/O — the service gathers the inputs. Detectors NEVER mutate financial records;
 * they only surface differences for human triage.
 *
 * Provider-comparison detectors run only when a provider lookup was actually
 * attempted (`provider` is null = looked up + missing; undefined = not looked up,
 * so skip to avoid false positives). Internal-only detectors (duplicate capture,
 * over-refund) always run.
 */
import { toCsv } from '../../common/csv';

export type DiscrepancyType =
  | 'PAYMENT_MISSING_INTERNALLY'
  | 'PAYMENT_MISSING_AT_PROVIDER'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_CAPTURE'
  | 'REFUND_MISMATCH'
  | 'CHARGEBACK'
  | 'SETTLEMENT_MISMATCH'
  | 'GATEWAY_FEE_MISMATCH'
  | 'ORGANIZER_PAYABLE_MISMATCH';

export interface ProviderStatus {
  providerRef: string;
  status: string;
  amountMinor: number;
  currency: string;
}

export interface OurPayment {
  bookingId: string;
  providerRef: string;
  provider: string;
  amountMinor: number;
  currency: string;
  /** Provider truth: object = found, null = looked up + missing, undefined = not looked up. */
  providerStatus?: ProviderStatus | null;
}

export interface OurRefund {
  bookingId: string;
  provider: string;
  providerRef: string;
  amountMinor: number;
  paymentAmountMinor: number;
}

export interface DiscrepancyCandidate {
  type: DiscrepancyType;
  provider: string;
  entityRef: string;
  amountMinor?: number;
  currency?: string;
  detail: string;
}

const SETTLED = new Set(['CAPTURED', 'SUCCEEDED']);

export function detectDiscrepancies(input: {
  payments: OurPayment[];
  refunds: OurRefund[];
}): DiscrepancyCandidate[] {
  const out: DiscrepancyCandidate[] = [];

  // Per-payment provider comparison (only when a lookup was attempted).
  for (const p of input.payments) {
    if (p.providerStatus === undefined) continue;
    if (p.providerStatus === null) {
      out.push({
        type: 'PAYMENT_MISSING_AT_PROVIDER',
        provider: p.provider,
        entityRef: p.providerRef,
        amountMinor: p.amountMinor,
        currency: p.currency,
        detail: `Payment ${p.providerRef} is SUCCEEDED internally but not found at ${p.provider}.`,
      });
      continue;
    }
    const ps = p.providerStatus;
    if (ps.amountMinor !== p.amountMinor) {
      out.push({
        type: 'AMOUNT_MISMATCH',
        provider: p.provider,
        entityRef: p.providerRef,
        amountMinor: p.amountMinor,
        currency: p.currency,
        detail: `Amount differs: internal ${p.amountMinor} vs provider ${ps.amountMinor}.`,
      });
    }
    if (ps.currency && ps.currency.toUpperCase() !== p.currency.toUpperCase()) {
      out.push({
        type: 'CURRENCY_MISMATCH',
        provider: p.provider,
        entityRef: p.providerRef,
        currency: p.currency,
        detail: `Currency differs: internal ${p.currency} vs provider ${ps.currency}.`,
      });
    }
    if (!SETTLED.has(ps.status.toUpperCase())) {
      out.push({
        type: 'PAYMENT_MISSING_AT_PROVIDER',
        provider: p.provider,
        entityRef: p.providerRef,
        amountMinor: p.amountMinor,
        currency: p.currency,
        detail: `Provider status is '${ps.status}' but internal is SUCCEEDED.`,
      });
    }
  }

  // Duplicate capture: the same providerRef settled more than once internally.
  const byRef = new Map<string, OurPayment[]>();
  for (const p of input.payments) {
    const list = byRef.get(p.providerRef) ?? [];
    list.push(p);
    byRef.set(p.providerRef, list);
  }
  for (const [ref, list] of byRef) {
    if (list.length > 1) {
      out.push({
        type: 'DUPLICATE_CAPTURE',
        provider: list[0].provider,
        entityRef: ref,
        detail: `Provider reference ${ref} maps to ${list.length} internal payments.`,
      });
    }
  }

  // Over-refund: refunded more than the captured amount.
  for (const r of input.refunds) {
    if (r.amountMinor > r.paymentAmountMinor) {
      out.push({
        type: 'REFUND_MISMATCH',
        provider: r.provider,
        entityRef: r.providerRef || r.bookingId,
        amountMinor: r.amountMinor,
        detail: `Refund ${r.amountMinor} exceeds captured ${r.paymentAmountMinor}.`,
      });
    }
  }

  return out;
}

/** CSV (RFC-4180-ish) for a set of discrepancy rows. */
export function discrepanciesToCsv(
  rows: {
    id: string;
    createdAt: Date | string;
    env: string;
    type: string;
    provider: string;
    entityRef: string;
    amountMinor: number | null;
    currency: string | null;
    status: string;
    assignedToUserId: string | null;
    resolutionNotes: string | null;
  }[],
): string {
  const header = [
    'id',
    'createdAt',
    'env',
    'type',
    'provider',
    'entityRef',
    'amountMinor',
    'currency',
    'status',
    'assignedTo',
    'resolutionNotes',
  ];
  // Use the shared, formula-injection-safe serializer (the previous inline escaper
  // quoted only when needed and had no injection guard).
  return toCsv(
    header,
    rows.map((r) => [
      r.id,
      new Date(r.createdAt).toISOString(),
      r.env,
      r.type,
      r.provider,
      r.entityRef,
      r.amountMinor ?? '',
      r.currency ?? '',
      r.status,
      r.assignedToUserId ?? '',
      r.resolutionNotes ?? '',
    ]),
  );
}

/** Aging buckets (days) for a set of open discrepancy timestamps. */
export function agingBuckets(
  openRows: { createdAt: Date | string }[],
  now: number,
): { bucket: string; count: number }[] {
  const buckets = [
    { bucket: '0-1d', max: 1 },
    { bucket: '1-3d', max: 3 },
    { bucket: '3-7d', max: 7 },
    { bucket: '7-30d', max: 30 },
    { bucket: '30d+', max: Infinity },
  ];
  const counts = buckets.map((b) => ({ bucket: b.bucket, count: 0 }));
  for (const row of openRows) {
    const ageDays = (now - new Date(row.createdAt).getTime()) / 86_400_000;
    const idx = buckets.findIndex((b) => ageDays <= b.max);
    counts[idx === -1 ? counts.length - 1 : idx].count += 1;
  }
  return counts;
}
