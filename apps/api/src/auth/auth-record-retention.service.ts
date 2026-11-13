import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Retention purge for temporary authentication records.
 *
 * ── WHAT IT COVERS ──────────────────────────────────────────────────────────────────
 * Short-lived, single-use, hashed credentials whose only job ends at expiry:
 *   - PhoneOtp              (sign-in codes; carries the phone number and the requesting IP)
 *   - EmailVerificationCode (carries the address being verified and the requesting IP)
 *   - PasswordResetToken    (carries the requesting IP)
 *   - AuthHandoff           (storefront -> console bridge codes; carries the requesting IP)
 *   - GuestBookingAccess    (emailed guest-booking links; the booking itself is untouched)
 * Refresh tokens have their own sweep (`AuthService.pruneExpiredRefreshTokens`).
 *
 * ── WHAT IT DELIBERATELY LEAVES ─────────────────────────────────────────────────────
 * AccountInvitation (one row per account, the "who let this person in" trail) and
 * TicketInvite (the ticket transfer ledger) are records, not throwaway credentials.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────────
 * - DRY RUN by default: counts only. Deletes only when RETENTION_PURGE_ENABLED=true.
 * - A row is eligible only when it EXPIRED more than the grace period ago, or was
 *   consumed/used more than the grace period ago AND has also expired. A valid
 *   (unexpired) record is never touched.
 * - Deletes in bounded batches (ids first, then `id IN (...)`), so a large backlog never
 *   holds a long lock. A per-run batch cap stops one run from looping forever.
 * - The summary is counts per model only: no phone, email, IP or token ever leaves here.
 */

export const AUTH_RECORD_RETENTION_DEFAULT_DAYS = 30;
export const AUTH_RECORD_RETENTION_DEFAULT_BATCH = 1000;
/** Upper bound on batches per model per run; the next daily run carries on. */
export const AUTH_RECORD_RETENTION_MAX_BATCHES = 500;

export interface AuthRecordRetentionConfig {
  enabled: boolean;
  graceDays: number;
  batchSize: number;
}

export type AuthRecordModel =
  | 'phoneOtp'
  | 'emailVerificationCode'
  | 'passwordResetToken'
  | 'authHandoff'
  | 'guestBookingAccess';

export const AUTH_RECORD_MODELS: readonly AuthRecordModel[] = [
  'phoneOtp',
  'emailVerificationCode',
  'passwordResetToken',
  'authHandoff',
  'guestBookingAccess',
];

export interface AuthRecordRetentionReport {
  mode: 'dry-run' | 'enabled';
  graceDays: number;
  cutoff: string;
  /** Rows eligible (dry run) or rows deleted (enabled), per model. */
  counts: Record<AuthRecordModel, number>;
  total: number;
  /** True when a model hit the per-run batch cap and has more to delete next run. */
  truncated: boolean;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * Safe parse: anything blank, non-numeric, fractional, zero or negative falls back to the
 * default. Only the exact string "true" (case-insensitive) enables deletion.
 */
export function parseAuthRecordRetentionConfig(
  env: Record<string, string | undefined> = process.env,
): AuthRecordRetentionConfig {
  return {
    enabled: (env.RETENTION_PURGE_ENABLED ?? '').trim().toLowerCase() === 'true',
    graceDays: parsePositiveInt(env.AUTH_RECORD_RETENTION_DAYS, AUTH_RECORD_RETENTION_DEFAULT_DAYS),
    batchSize: Math.min(
      parsePositiveInt(env.AUTH_RECORD_RETENTION_BATCH_SIZE, AUTH_RECORD_RETENTION_DEFAULT_BATCH),
      10_000,
    ),
  };
}

/** The eligibility filter per model. Every branch requires the expiry itself to be in the past. */
export function authRecordWhere(
  model: AuthRecordModel,
  now: Date,
  cutoff: Date,
): Record<string, unknown> {
  const expiredLongAgo = { expiresAt: { lt: cutoff } };
  const spentLongAgo = (field: 'consumedAt' | 'usedAt') => ({
    AND: [{ [field]: { lt: cutoff } }, { expiresAt: { lt: now } }],
  });
  switch (model) {
    case 'phoneOtp':
    case 'emailVerificationCode':
    case 'authHandoff':
      return { OR: [expiredLongAgo, spentLongAgo('consumedAt')] };
    case 'passwordResetToken':
      return { OR: [expiredLongAgo, spentLongAgo('usedAt')] };
    case 'guestBookingAccess':
      return expiredLongAgo;
  }
}

interface Delegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  findMany(args: {
    where: Record<string, unknown>;
    select: { id: true };
    take: number;
    orderBy: { id: 'asc' };
  }): Promise<Array<{ id: string }>>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

@Injectable()
export class AuthRecordRetentionService {
  constructor(private readonly prisma: PrismaService) {}

  async run(
    now: Date = new Date(),
    config: AuthRecordRetentionConfig = parseAuthRecordRetentionConfig(),
  ): Promise<AuthRecordRetentionReport> {
    const cutoff = new Date(now.getTime() - config.graceDays * 24 * 60 * 60 * 1000);
    const counts = {} as Record<AuthRecordModel, number>;
    let truncated = false;

    for (const model of AUTH_RECORD_MODELS) {
      const delegate = this.prisma[model] as unknown as Delegate;
      const where = authRecordWhere(model, now, cutoff);
      if (!config.enabled) {
        counts[model] = await delegate.count({ where });
        continue;
      }
      let deleted = 0;
      let batches = 0;
      for (;;) {
        if (batches >= AUTH_RECORD_RETENTION_MAX_BATCHES) {
          truncated = true;
          break;
        }
        const ids = await delegate.findMany({
          where,
          select: { id: true },
          take: config.batchSize,
          orderBy: { id: 'asc' },
        });
        if (ids.length === 0) break;
        batches += 1;
        // Re-applies the eligibility filter: a row that changed since it was read is skipped.
        const { count } = await delegate.deleteMany({
          where: { AND: [{ id: { in: ids.map((r) => r.id) } }, where] },
        });
        deleted += count;
        if (ids.length < config.batchSize) break;
      }
      counts[model] = deleted;
    }

    return {
      mode: config.enabled ? 'enabled' : 'dry-run',
      graceDays: config.graceDays,
      cutoff: cutoff.toISOString(),
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      truncated,
    };
  }
}
