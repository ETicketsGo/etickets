import { Injectable, Logger } from '@nestjs/common';
import { PayoutStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/errors';
import { PayoutsService } from './payouts.service';
import { PayoutSettingsService } from './payout-settings.service';

/**
 * The settlement run: the platform raising payouts by itself, on the terms an admin set.
 *
 * ── WHY THIS IS A RUN AND NOT A CRON PER ORGANIZATION ──────────────────────────────
 * Every organizer settles on their own terms, so "when is it due" is a question per
 * organization, not a global schedule. The worker ticks hourly and this decides, per
 * organization, whether their next run has come round. That keeps one moving part instead of
 * a scheduler entry per organizer, and an organizer whose terms change is on the new schedule
 * immediately rather than at the next deploy.
 *
 * ── WHY IT IS OFF UNTIL SOMEBODY TURNS IT ON ───────────────────────────────────────
 * An automatic payout is money leaving on a date nobody chose. It runs only where
 * `autoGenerate` is set, which is nowhere by default.
 *
 * ── WHAT A RUN PRODUCES ────────────────────────────────────────────────────────────
 * SCHEDULED payouts, not PENDING ones, and that distinction is the whole point of the
 * status: PENDING is "somebody raised this and is dealing with it", SCHEDULED is "the
 * platform raised this and it is queued for the payment run on `scheduledAt`". Finance reads
 * the difference; the status existed in the schema for it and nothing had ever written it.
 */
@Injectable()
export class PayoutRunService {
  private readonly logger = new Logger('PayoutRun');

  constructor(
    private readonly prisma: PrismaService,
    private readonly payouts: PayoutsService,
    private readonly settings: PayoutSettingsService,
  ) {}

  /**
   * Raise the settlements that are due.
   *
   * Returns counts rather than throwing: this is a sweep, and one organization whose
   * settlement cannot be raised must not stop the others.
   */
  async runDue(now = new Date()): Promise<{ considered: number; raised: number; skipped: number }> {
    const organizations = await this.prisma.organization.findMany({
      select: { id: true },
      // Bounded, like every other sweep in this worker. A platform with more organizations
      // than this settles the rest on the next tick rather than holding one transaction open.
      take: 500,
      orderBy: { createdAt: 'asc' },
    });

    let considered = 0;
    let raised = 0;
    let skipped = 0;

    for (const organization of organizations) {
      const terms = await this.settings.effectiveFor(organization.id);
      if (!terms.autoGenerate) continue;
      considered += 1;

      const due = isDue(now, terms.lastRunAt, terms.runFrequency, terms.runAnchorDay);
      if (!due) continue;

      /*
        Stamped BEFORE the attempt, and stamped even when the attempt raises nothing.

        A run that correctly found nothing - everything held, or below the minimum - still
        happened. Leaving the stamp alone would make it due again on the next tick, hammering
        the ledger every hour for a result that cannot change until more money arrives or the
        hold expires.
      */
      await this.stamp(organization.id, now);

      try {
        const created = await this.payouts.generateAutomatically(
          organization.id,
          nextRunAfter(now, terms.runFrequency, terms.runAnchorDay),
        );
        if (created.length > 0) {
          raised += created.length;
          this.logger.log(
            `settlement run raised ${created.length} payout(s) for ${organization.id}`,
          );
        } else {
          skipped += 1;
        }
      } catch (err) {
        /*
          The expected refusals are ordinary: nothing new to settle, everything still held,
          an open payout already covering the currency, or a total below the minimum. They are
          how the ledger says "not yet", so they are counted rather than logged as failures.
        */
        skipped += 1;
        if (!(err instanceof AppException)) {
          this.logger.warn(
            `settlement run failed for ${organization.id}: ${(err as Error).message}`,
          );
        }
      }
    }

    return { considered, raised, skipped };
  }

  /** Record that this scope's run has happened, whatever it produced. */
  private async stamp(organizationId: string, at: Date): Promise<void> {
    const existing = await this.prisma.payoutSetting.findFirst({ where: { organizationId } });
    if (existing) {
      await this.prisma.payoutSetting.update({
        where: { id: existing.id },
        data: { lastRunAt: at },
      });
      return;
    }
    /*
      An organization settling on the PLATFORM's schedule has no row of its own. It gets one
      holding nothing but the stamp: every term stays null, so it keeps inheriting, and the
      platform row's own `lastRunAt` is never used as a shared cursor - which would mean the
      first organization swept each day stopped every other one from running.
    */
    await this.prisma.payoutSetting.create({ data: { organizationId, lastRunAt: at } });
  }
}

/** Whether a scope's next run has come round. */
export function isDue(
  now: Date,
  lastRunAt: Date | null,
  frequency: string | null,
  anchorDay: number | null,
): boolean {
  // Never run: due the first time the sweep sees it, so turning it on does something today.
  if (!lastRunAt) return true;

  const sinceMs = now.getTime() - lastRunAt.getTime();
  const day = 24 * 60 * 60 * 1000;

  switch ((frequency ?? 'WEEKLY').toUpperCase()) {
    case 'DAILY':
      return sinceMs >= day;
    case 'MONTHLY':
      // The anchor day, and never past the 28th - a run anchored to the 31st would skip
      // February, and nobody notices until an organizer asks where their money is.
      return sinceMs >= 27 * day && now.getUTCDate() >= clampAnchor(anchorDay, 1, 28, 1);
    case 'WEEKLY':
    default:
      return sinceMs >= 6 * day && isoWeekday(now) === clampAnchor(anchorDay, 1, 7, 1);
  }
}

/** When the payouts this run raises are expected to be paid. */
export function nextRunAfter(now: Date, frequency: string | null, anchorDay: number | null): Date {
  const day = 24 * 60 * 60 * 1000;
  switch ((frequency ?? 'WEEKLY').toUpperCase()) {
    case 'DAILY':
      return new Date(now.getTime() + day);
    case 'MONTHLY': {
      const next = new Date(now.getTime());
      next.setUTCMonth(next.getUTCMonth() + 1);
      next.setUTCDate(clampAnchor(anchorDay, 1, 28, 1));
      return next;
    }
    case 'WEEKLY':
    default:
      return new Date(now.getTime() + 7 * day);
  }
}

function clampAnchor(value: number | null, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Monday is 1, Sunday is 7 - the ISO convention the anchor day is written in. */
function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/** Re-exported so the worker can log what it is about to write. */
export const SCHEDULED_BY_RUN = PayoutStatus.SCHEDULED;
