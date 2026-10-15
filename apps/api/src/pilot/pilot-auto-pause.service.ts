import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { EventStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../redis/redis.service';
import { OpsAlertService, type OpsAlert } from '../ops/alerts/ops-alert.service';
import { pilotAutoPausedAlert } from '../ops/alerts/ops-alert-messages';
import { PILOT_WEBHOOK_WINDOW_MS } from './pilot-config';
import { PILOT_AUTO_PAUSE_ACTION, PilotGuardService } from './pilot-guard.service';

export type PilotPauseTrigger =
  | 'CAPTURE_NOT_APPLIED'
  | 'CONFIRMATION_FAILED_AFTER_PAYMENT'
  | 'PAID_BOOKING_NOT_RECOVERED'
  | 'RECONCILIATION_MISMATCH'
  | 'WEBHOOK_SIGNATURE_REJECTIONS';

export interface PilotPauseOutcome {
  trigger: PilotPauseTrigger | null;
  pausedEventIds: string[];
}

const NOTHING: PilotPauseOutcome = { trigger: null, pausedEventIds: [] };
/** Statuses that are on sale. A DRAFT, a CANCELLED or an already PAUSED event is left alone. */
const ON_SALE: EventStatus[] = [EventStatus.PUBLISHED, EventStatus.SOLD_OUT];
const REJECTS_KEY = 'pilot:webhook-rejects';

/**
 * Takes pilot events off sale the moment the money path reports something it cannot handle.
 *
 * ── WHAT IT LISTENS TO ────────────────────────────────────────────────────────────
 * The ops alerts PR #375 put on the money path. They already fire at exactly the moments the
 * owner named, and subscribing to them means not one line of payment, webhook or reconciliation
 * code changes:
 *   - CAPTURE_NOT_APPLIED: money captured for a booking that cannot take it -> that event;
 *   - CONFIRMATION_FAILED_AFTER_PAYMENT: paid, then our confirmation threw -> that event;
 *   - EXPIRY_FOUND_CAPTURE with recovery_failed: paid, not confirmed, not recoverable -> that event;
 *   - FINANCE_DISCREPANCY_OPENED on a pilot payment: a reconciliation mismatch -> that event;
 *   - WEBHOOK_SIGNATURE_REJECTED, PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD times inside ten minutes
 *     -> every pilot event on sale, because a broken webhook secret means NO payment will be
 *     confirmed (the 2026-10-06 incident), whichever event it was for.
 * A recovered expiry is not a trigger: the booking was confirmed, and the webhook alert that
 * usually explains it is counted on its own.
 *
 * ── HOW IT PAUSES ─────────────────────────────────────────────────────────────────
 * The same write an admin pause makes (`EventsService.adminSetStatus`): status PAUSED and
 * `pausedByAdminAt`, so the organizer cannot resume it and an admin must look first. Conditional
 * on the event still being on sale, so a repeat trigger writes nothing twice. Each pause writes
 * an EVENT_AUTO_PAUSED audit row with no actor user (the system) and the trigger as its reason,
 * and one PILOT_AUTO_PAUSED ops alert lists what was paused.
 *
 * ── WHAT IT MUST NEVER DO ─────────────────────────────────────────────────────────
 * Throw into the money path. It runs on its own promise from `OpsAlertService.subscribe`, and
 * `handle` swallows every failure besides. Pausing an event changes nothing about a booking or
 * a payment already made; it only stops new ones.
 */
@Injectable()
export class PilotAutoPauseService implements OnModuleInit {
  private readonly logger = new Logger('PilotAutoPause');
  /** Used when Redis is absent or refusing: per process. */
  private memoryRejects: number[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: PilotGuardService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly alerts?: OpsAlertService,
    @Optional() private readonly redis?: RedisService,
    /** For tests: a fixed clock. */
    @Optional() @Inject('PILOT_CLOCK') private readonly now: () => number = Date.now,
  ) {}

  onModuleInit(): void {
    this.alerts?.subscribe((alert) => this.handle(alert));
  }

  private enabled(): boolean {
    const c = this.guard.pilotConfig;
    if (c.mode === 'off') return false;
    return c.valid ? c.limits.autoPause : c.autoPause;
  }

  private threshold(): number {
    const c = this.guard.pilotConfig;
    return c.mode === 'off'
      ? Infinity
      : c.valid
        ? c.limits.webhookRejectThreshold
        : c.webhookRejectThreshold;
  }

  /** Act on one alert. Never rejects. */
  async handle(alert: OpsAlert): Promise<PilotPauseOutcome> {
    try {
      if (alert.kind === 'PILOT_AUTO_PAUSED' || !this.enabled()) return NOTHING;
      const bookingId = typeof alert.facts.bookingId === 'string' ? alert.facts.bookingId : null;
      switch (alert.kind) {
        case 'CAPTURE_NOT_APPLIED':
          return await this.pauseForBooking(bookingId, 'CAPTURE_NOT_APPLIED', alert);
        case 'CONFIRMATION_FAILED_AFTER_PAYMENT':
          return await this.pauseForBooking(bookingId, 'CONFIRMATION_FAILED_AFTER_PAYMENT', alert);
        case 'EXPIRY_FOUND_CAPTURE':
          return alert.facts.outcome === 'recovery_failed'
            ? await this.pauseForBooking(bookingId, 'PAID_BOOKING_NOT_RECOVERED', alert)
            : NOTHING;
        case 'FINANCE_DISCREPANCY_OPENED': {
          const ref = typeof alert.facts.entityRef === 'string' ? alert.facts.entityRef : null;
          return await this.pauseForBooking(
            await this.bookingForRef(ref),
            'RECONCILIATION_MISMATCH',
            alert,
          );
        }
        case 'WEBHOOK_SIGNATURE_REJECTED':
          return await this.countRejection(alert);
        default:
          return NOTHING;
      }
    } catch (err) {
      this.logger.error(
        `Pilot auto-pause could not act on ${alert.kind}: ${err instanceof Error ? err.message : err}`,
      );
      return NOTHING;
    }
  }

  private async pauseForBooking(
    bookingId: string | null,
    trigger: PilotPauseTrigger,
    alert: OpsAlert,
  ): Promise<PilotPauseOutcome> {
    if (!bookingId) return NOTHING;
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { eventId: true, organizationId: true },
    });
    if (!booking || !this.guard.isPilotOrganization(booking.organizationId)) return NOTHING;
    return this.pause([booking.eventId], trigger, alert, bookingId);
  }

  /**
   * A discrepancy names a provider reference, or a booking id when there was none (see
   * `discrepancy-detectors.ts`). Resolved to the booking through our own rows only.
   */
  private async bookingForRef(ref: string | null): Promise<string | null> {
    if (!ref) return null;
    const direct = await this.prisma.booking.findUnique({
      where: { id: ref },
      select: { id: true },
    });
    if (direct) return direct.id;
    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [{ providerRef: ref }, { providerPaymentIntentId: ref }, { providerOrderId: ref }],
      },
      select: { bookingId: true },
    });
    if (payment) return payment.bookingId;
    const refund = await this.prisma.refund.findFirst({
      where: { providerRef: ref },
      select: { bookingId: true },
    });
    return refund?.bookingId ?? null;
  }

  private async countRejection(alert: OpsAlert): Promise<PilotPauseOutcome> {
    const now = this.now();
    const count = await this.rejectionsInWindow(now);
    if (count < this.threshold()) return NOTHING;
    const ids = this.pilotOrganizationIds();
    if (ids.length === 0) return NOTHING;
    const events = await this.prisma.event.findMany({
      where: { organizationId: { in: ids }, status: { in: ON_SALE } },
      select: { id: true },
    });
    return this.pause(
      events.map((e) => e.id),
      'WEBHOOK_SIGNATURE_REJECTIONS',
      alert,
      null,
      { rejectionsInWindow: count, windowMinutes: PILOT_WEBHOOK_WINDOW_MS / 60000 },
    );
  }

  /**
   * Sliding ten-minute window, shared across API replicas through a Redis sorted set: a storm
   * of bad deliveries is spread over every replica, and only the sum says it is a storm.
   */
  private async rejectionsInWindow(now: number): Promise<number> {
    const since = now - PILOT_WEBHOOK_WINDOW_MS;
    if (this.redis) {
      try {
        const c = this.redis.client;
        await c.zadd(REJECTS_KEY, now, `${now}:${Math.random().toString(36).slice(2)}`);
        await c.zremrangebyscore(REJECTS_KEY, '-inf', since);
        await c.pexpire(REJECTS_KEY, PILOT_WEBHOOK_WINDOW_MS);
        return await c.zcard(REJECTS_KEY);
      } catch {
        // Fall through to the in-process window.
      }
    }
    this.memoryRejects = this.memoryRejects.filter((t) => t > since);
    this.memoryRejects.push(now);
    return this.memoryRejects.length;
  }

  private pilotOrganizationIds(): string[] {
    const c = this.guard.pilotConfig;
    if (c.mode === 'off') return [];
    return c.valid ? c.limits.organizationIds : c.organizationIds;
  }

  private async pause(
    eventIds: string[],
    trigger: PilotPauseTrigger,
    alert: OpsAlert,
    bookingId: string | null,
    extra: Record<string, number> = {},
  ): Promise<PilotPauseOutcome> {
    const paused: string[] = [];
    for (const id of eventIds) {
      try {
        const event = await this.prisma.event.findUnique({
          where: { id },
          select: { organizationId: true },
        });
        if (!event) continue;
        const res = await this.prisma.event.updateMany({
          where: { id, status: { in: ON_SALE } },
          data: { status: EventStatus.PAUSED, pausedByAdminAt: new Date(this.now()) },
        });
        if (res.count === 0) continue;
        paused.push(id);
        await this.audit?.record({
          actorUserId: null,
          organizationId: event.organizationId,
          action: PILOT_AUTO_PAUSE_ACTION,
          entityType: 'Event',
          entityId: id,
          metadata: {
            status: EventStatus.PAUSED,
            actor: 'system',
            reason: `Pilot auto-pause: ${trigger}`,
            trigger,
            sourceAlert: alert.kind,
            bookingId,
            ...extra,
          },
        });
      } catch (err) {
        // One event that cannot be paused must not stop the others.
        this.logger.error(
          `Pilot auto-pause could not pause event ${id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (paused.length > 0) {
      this.logger.error(`Pilot auto-pause (${trigger}) paused: ${paused.join(', ')}`);
      void this.alerts?.notify(
        pilotAutoPausedAlert({ trigger, eventIds: paused, bookingId, sourceKind: alert.kind }),
      );
    }
    return { trigger, pausedEventIds: paused };
  }
}
