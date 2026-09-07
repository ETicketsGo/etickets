import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DeliveryState,
  FailureClass,
  SendKind,
  isConfigurationBlocked,
  isRetryableFailure,
  isTerminalDelivery,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { SuppressionService } from './suppression.service';
import { maskPhone } from '../channels/transports/recipient.util';

/**
 * What an operator can see and do about a notification that did not arrive.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────────────
 * "The customer says they never got their ticket" was previously answerable only by somebody
 * with a psql prompt. The row said SENT whatever happened, so even then the answer was
 * usually wrong. With per-attempt records and provider callbacks there is now something real
 * to look at, and this is the surface that exposes it without handing out database access.
 *
 * ── WHAT IT DELIBERATELY DOES NOT EXPOSE ───────────────────────────────────────────
 * The message body and the full destination. An operator needs to know WHICH message and
 * WHETHER it arrived, and neither answer requires reading somebody's ticket details or
 * copying their phone number. The payload is summarised to its identifiers.
 */
/** Classes meaning "a person must change something". Derived, never hand-listed. */
const CONFIG_BLOCKED_CLASSES = Object.values(FailureClass).filter(isConfigurationBlocked);
/** Classes a retry could have cleared, so exhaustion is worth revisiting. */
const RETRYABLE_CLASSES = Object.values(FailureClass).filter(isRetryableFailure);

@Injectable()
export class NotificationOpsService {
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly suppression: SuppressionService,
  ) {}

  /**
   * Search notifications the way support actually asks about them: by the booking reference
   * a customer reads out, or by what is going wrong across a channel or provider.
   */
  async search(q: {
    reference?: string;
    type?: string;
    channel?: string;
    provider?: string;
    status?: string;
    /**
     * The normalized reason the last attempt failed.
     *
     * -- WHY STATUS ALONE WAS NOT ENOUGH ---------------------------------------------
     * `status=FAILED` returns everything that did not go out, which after a launch is a
     * single undifferentiated list: dead phone numbers, a provider that was down for ten
     * minutes, and the twelve messages blocked on a DLT template somebody has to chase.
     * They need completely different actions and only one of them is anybody's job today.
     */
    failureClass?: string;
    /**
     * `true` narrows to everything waiting on a person to change configuration or finish a
     * registration -- the operator's own queue, which is the first thing to look at after a
     * launch and was previously impossible to ask for.
     */
    configBlocked?: boolean;
    /** Attempts exhausted rather than permanently refused: worth a resend once healthy. */
    retryExhausted?: boolean;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const where: Prisma.NotificationWhereInput = {
      ...(q.type ? { type: q.type as never } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.provider ? { deliveries: { some: { provider: q.provider } } } : {}),
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {}),
      /*
        The reference a customer reads off their confirmation. It lives inside the JSON
        payload rather than in a column, so this is a JSON path filter -- which is exact, not
        a scan, and is the only handle a support conversation ever starts from.
      */
      ...(q.reference ? { payload: { path: ['reference'], equals: q.reference } } : {}),
      ...(q.failureClass ? { deliveries: { some: { failureClass: q.failureClass } } } : {}),
      /*
        Asked of the DELIVERY rows rather than the notification, because the classification
        belongs to an attempt: the same notification can be rate-limited once and then blocked
        on a template, and the useful question is which of those is true now.
      */
      ...(q.configBlocked
        ? { deliveries: { some: { failureClass: { in: [...CONFIG_BLOCKED_CLASSES] } } } }
        : {}),
      /*
        Exhausted, not refused. A message that used up its attempts against a provider that
        was down is worth resending once the provider is back; one permanently refused is not,
        and lumping them together makes a bulk resend either useless or wasteful.
      */
      ...(q.retryExhausted
        ? {
            status: 'FAILED',
            attempts: { gte: 3 },
            deliveries: { some: { failureClass: { in: [...RETRYABLE_CLASSES] } } },
          }
        : {}),
    };

    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(q.limit ?? 50, 200),
      select: {
        id: true,
        type: true,
        channel: true,
        status: true,
        locale: true,
        toEmail: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        sentAt: true,
        deliveries: {
          orderBy: { attemptNumber: 'desc' },
          take: 1,
          select: { provider: true, status: true, providerMessageId: true },
        },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      channel: r.channel,
      status: r.status,
      locale: r.locale,
      recipient: maskEmail(r.toEmail),
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
      provider: r.deliveries[0]?.provider ?? null,
      deliveryState: r.deliveries[0]?.status ?? null,
      providerMessageId: r.deliveries[0]?.providerMessageId ?? null,
    }));
  }

  /** One notification and every attempt made to deliver it. */
  async inspect(id: string) {
    const row = await this.prisma.notification.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        channel: true,
        status: true,
        locale: true,
        toEmail: true,
        userId: true,
        attempts: true,
        lastError: true,
        scheduledFor: true,
        sentAt: true,
        createdAt: true,
        payload: true,
        deliveries: {
          orderBy: { attemptNumber: 'asc' },
          select: {
            id: true,
            attemptNumber: true,
            provider: true,
            status: true,
            providerStatus: true,
            providerMessageId: true,
            failureCode: true,
            failureReason: true,
            attemptedAt: true,
            acceptedAt: true,
            deliveredAt: true,
            failedAt: true,
          },
        },
      },
    });
    if (!row)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Notification not found.', HttpStatus.NOT_FOUND);

    return {
      ...row,
      toEmail: maskEmail(row.toEmail),
      /*
        Identifiers only. An operator diagnosing a delivery needs to know which booking the
        message was about; they do not need the seat numbers, the amount paid or the QR.
      */
      payload: summarise(row.payload as Record<string, unknown> | null),
    };
  }

  /** How each provider is doing, over a window. The number that was previously invisible. */
  async providerHealth(sinceHours = 24) {
    const since = new Date(Date.now() - sinceHours * 3_600_000);
    const grouped = await this.prisma.notificationDelivery.groupBy({
      by: ['provider', 'channel', 'status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _max: { acceptedAt: true },
    });

    interface Health {
      provider: string;
      channel: string;
      states: Record<string, number>;
      lastAcceptedAt: Date | null;
    }
    const byProvider = new Map<string, Health>();
    for (const g of grouped) {
      const key = `${g.provider}:${g.channel}`;
      const entry: Health = byProvider.get(key) ?? {
        provider: g.provider,
        channel: g.channel,
        states: {},
        lastAcceptedAt: null,
      };
      entry.states[g.status] = g._count._all;
      if (
        g._max.acceptedAt &&
        (!entry.lastAcceptedAt || g._max.acceptedAt > entry.lastAcceptedAt)
      ) {
        entry.lastAcceptedAt = g._max.acceptedAt;
      }
      byProvider.set(key, entry);
    }

    return [...byProvider.values()].map((e) => {
      const states = e.states;
      const total = Object.values(states).reduce((a, b) => a + b, 0);
      const bad =
        (states[DeliveryState.FAILED] ?? 0) +
        (states[DeliveryState.UNDELIVERED] ?? 0) +
        (states[DeliveryState.BOUNCED] ?? 0) +
        (states[DeliveryState.REJECTED] ?? 0);
      return {
        ...e,
        total,
        // A rate, not a count: ten failures out of ten is an outage and ten out of ten
        // thousand is a Tuesday.
        failureRate: total > 0 ? Number((bad / total).toFixed(4)) : 0,
      };
    });
  }

  /**
   * Send it again, on purpose.
   *
   * ── WHY RESEND AND RETRY ARE DIFFERENT WORDS ───────────────────────────────────────
   * RETRY belongs to the worker, and applies only to an attempt that never reached a
   * provider. RESEND is an operator deciding that a message which the provider ACCEPTED, and
   * charged for, should go out a second time — because the first was undelivered and the
   * customer is on the phone. The platform must never make that decision automatically: for
   * a handset that was switched off, the carrier may yet deliver the first one, and the
   * customer gets their ticket twice at our expense.
   *
   * ── WHAT IT REFUSES ────────────────────────────────────────────────────────────────
   * A suppressed destination, because the address is unusable and sending again earns
   * another bounce against the sending domain. And a message that was actually delivered,
   * unless the operator says explicitly that they mean it — the common support mistake is
   * resending something the customer has and cannot find.
   */
  async resend(
    actorUserId: string,
    notificationId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ requeued: true }> {
    const row = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        channel: true,
        toEmail: true,
        userId: true,
        status: true,
        deliveries: { orderBy: { attemptNumber: 'desc' }, take: 1, select: { status: true } },
      },
    });
    if (!row)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Notification not found.', HttpStatus.NOT_FOUND);

    const destination = row.channel === 'email' ? row.toEmail : await this.phoneOf(row.userId);
    if (destination && (await this.suppression.isSuppressed(row.channel, destination))) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This destination is suppressed. Lift the suppression first, deliberately.',
        HttpStatus.CONFLICT,
      );
    }

    const last = row.deliveries[0]?.status as DeliveryState | undefined;
    if (last === DeliveryState.DELIVERED && !opts.force) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This notification was delivered. Pass force to resend it anyway.',
        HttpStatus.CONFLICT,
      );
    }
    if (last && isTerminalDelivery(last) && last !== DeliveryState.UNDELIVERED && !opts.force) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This notification ended as ${last}. Pass force to resend it anyway.`,
        HttpStatus.CONFLICT,
      );
    }

    /*
      The SAME notification is requeued -- its dedupe key is untouched, so this is not a way
      to smuggle a second copy of an intent past the Phase 1 guarantee. What changes is that
      a new ATTEMPT will be opened, which is exactly what a resend is.
    */
    /*
      Marked MANUAL_RESEND so the provider charge it produces is attributable. Support
      resending a ticket is a real cost incurred on somebody's behalf, and it is invisible in
      a total that counts it as an ordinary send. The dedupe key is untouched -- this is not
      a route around the Phase 1 guarantee, it is a new ATTEMPT on the same intent.
    */
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: 'PENDING',
        scheduledFor: new Date(),
        lastError: null,
        sendReason: SendKind.MANUAL_RESEND,
      },
    });

    await this.audit.record({
      actorUserId,
      action: 'NOTIFICATION_RESENT',
      entityType: 'Notification',
      entityId: notificationId,
      metadata: { channel: row.channel, previousDeliveryState: last ?? null, forced: !!opts.force },
    });
    this.logger.warn(`notification ${notificationId} resent by ${actorUserId}`);
    return { requeued: true };
  }

  /** Lift a suppression. Audited, and never a delete — the history of why survives. */
  async liftSuppression(actorUserId: string, id: string): Promise<{ lifted: boolean }> {
    const lifted = await this.suppression.lift(id, actorUserId);
    if (lifted) {
      await this.audit.record({
        actorUserId,
        action: 'SUPPRESSION_LIFTED',
        entityType: 'SuppressedDestination',
        entityId: id,
        metadata: {},
      });
    }
    return { lifted };
  }

  private async phoneOf(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const user = await this.prisma.user
      .findUnique({ where: { id: userId }, select: { phone: true } })
      .catch(() => null);
    return user?.phone ?? null;
  }
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  return domain ? `${local.slice(0, 2)}***@${domain}` : '***';
}

/** Identifiers only — never the seats, the amount or anything that renders the message. */
const SAFE_PAYLOAD_KEYS = ['bookingId', 'reference', 'refundId', 'settlementId', 'eventTitle'];

function summarise(payload: Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) return {};
  const out: Record<string, unknown> = {};
  for (const k of SAFE_PAYLOAD_KEYS) if (k in payload) out[k] = payload[k];
  if ('phone' in payload) out.phone = maskPhone(String(payload.phone));
  return out;
}
