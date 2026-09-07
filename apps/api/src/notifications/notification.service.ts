import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationTemplateService } from './templates/notification-template.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationChannelRegistry } from './channels/notification-channel.registry';
import { MarketingConsentService } from './marketing-consent.service';
import {
  isTransactional,
  messageClassOf,
  typesForAudience,
  type MessageAudience,
} from './message-class';
import { ChannelKey, RenderedNotification } from './channels/notification-channel.interface';
import { permittedChannels } from './policy/channel-policy';
import { dedupeKeyFor } from './policy/dedupe-key';
import { MetricsService } from '../metrics/metrics.service';
import { TransportError } from './channels/transports/transport-http';

/**
 * Input to {@link NotificationService.send}. `channels` and `locale` are
 * optional so existing callers keep working unchanged: with neither provided,
 * a single email notification is persisted (status SENT) and delivered, exactly
 * reproducing the original behaviour.
 */
export interface NotifyInput {
  type: NotificationType;
  userId?: string | null;
  toEmail?: string | null;
  payload: Record<string, unknown>;
  channels?: string[];
  locale?: string;
  /**
   * The market this message is going into, when the sender knows it from its own records
   * (a booking's venue, an organization's registered country). Used only to pick a provider.
   */
  country?: string | null;
  /**
   * A stable identity for the business intent, when the caller has one that is better than
   * what can be derived from the payload. Two sends carrying the same intent are the same
   * message, and only one of them goes out.
   */
  intentKey?: string | null;
}

/** Outcome counts from a scheduled-dispatch sweep. */
export interface DispatchSummary {
  sent: number;
  failed: number;
  retried: number;
}

// The per-type channel policy now decides this; see policy/channel-policy.ts, whose
// FALLBACK_CHANNELS is this same email + inbox + push list for any type not named there.
const DEFAULT_LOCALE = 'en';

/**
 * Notification abstraction. MVP persists a Notification row per resolved channel
 * and delegates delivery to log-only channel stubs; real providers
 * (SendGrid/Twilio/FCM) plug in behind each NotificationChannel.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: NotificationTemplateService,
    private readonly preferences: NotificationPreferencesService,
    private readonly channels: NotificationChannelRegistry,
    private readonly consent: MarketingConsentService,
    private readonly metrics?: MetricsService,
  ) {}

  /**
   * Sends a notification immediately. Resolves channels (default `['email']`)
   * filtered by user preferences, renders a per-channel template, then for EACH
   * channel persists a SENT row and delivers via the channel.
   */

  /**
   * The language to write to this person in.
   *
   * ── WHY IT IS LOOKED UP HERE AND NOT PASSED IN ─────────────────────────────────────
   * `NotifyInput.locale` has existed since the beginning and no caller has ever set it, so
   * every notification the platform has ever sent went out in the default. Leaving it to
   * callers means thirty call sites each needing to remember, and one that forgets sends a
   * Quebec customer their booking confirmation in English — which is the specific failure
   * the Charter of the French Language is about.
   *
   * So the recipient's own stored preference wins, an explicit `input.locale` is the
   * override for the cases that genuinely know better (an admin digest addressed to staff),
   * and the default is last. A guest booking with no account has no stored preference, which
   * is why the checkout passes `locale` explicitly for those.
   */
  private async localeFor(input: NotifyInput): Promise<string> {
    if (input.locale) return input.locale;
    if (!input.userId) return DEFAULT_LOCALE;
    const user = await this.prisma.user
      .findUnique({ where: { id: input.userId }, select: { locale: true } })
      .catch(() => null);
    return user?.locale ?? DEFAULT_LOCALE;
  }

  /**
   * Record a notification for delivery. Returns as soon as it is durably written.
   *
   * -- WHY THIS NO LONGER TALKS TO A PROVIDER ----------------------------------------
   * It used to deliver inline, in the caller's request, unguarded. Sixteen services call
   * this, and two of them call it immediately after money has moved: PaymentsService once a
   * payment is captured and a booking confirmed, RefundsService once a refund has completed
   * and a credit note has been issued. An unguarded await there means that when SES is slow
   * or Twilio is down, the exception unwinds through a path whose work has ALREADY
   * COMMITTED. The customer has been charged, the booking is confirmed in the database, and
   * the request returns an error. A notification provider outage became a payment outage,
   * and the only reason it never has is that the provider has always been `log`.
   *
   * So this now does one thing: it writes the rows. Provider I/O belongs to the worker,
   * which already sweeps this table, already retries, and already has somewhere to record a
   * failure. The caller cannot fail because of a provider it never called.
   *
   * -- WHY THE ROWS ARE PENDING AND NOT SENT -----------------------------------------
   * Because at this moment nobody has sent anything. The old code wrote `status: 'SENT'`
   * and `sentAt: now` BEFORE attempting delivery, so the database recorded a successful send
   * for every message a provider subsequently refused, and support had no way to tell a
   * delivered ticket from a dropped one.
   *
   * -- OPTIONALLY INSIDE THE CALLER'S TRANSACTION ------------------------------------
   * Passing `tx` writes the rows in the same transaction as the business change, so a
   * committed booking and its confirmation are one atomic fact and a crash in between cannot
   * lose the message. Callers without a transaction are unchanged.
   */
  async send(input: NotifyInput, tx?: Prisma.TransactionClient): Promise<void> {
    await this.enqueue(input, { scheduledFor: new Date(), status: 'PENDING' }, tx);
  }

  /**
   * Persists a notification per resolved channel with status SCHEDULED and the
   * given `scheduledFor`, WITHOUT delivering. Returns the created row ids.
   */
  async schedule(input: NotifyInput, scheduledFor: Date): Promise<string[]> {
    /*
      Resolved at SCHEDULE time and stored on the row, not resolved again at send time.

      A reminder queued three weeks ago should arrive in the language the person was using
      when it was queued. Re-resolving on dispatch would mean a preference changed in between
      silently rewrites messages that were already composed — and the row already carries
      `locale` precisely so the dispatcher does not have to guess.
    */
    return this.enqueue(input, { scheduledFor, status: 'SCHEDULED' });
  }

  /**
   * The one place a notification row is created -- immediate and scheduled alike.
   *
   * -- HOW A DUPLICATE IS STOPPED ----------------------------------------------------
   * By the unique index on `dedupeKey`, and by nothing else. Every mechanism that causes a
   * duplicate outlives a process: a BullMQ job retried after a timeout, a worker restarted
   * mid-batch, a redelivered event, two API instances handling the same webhook. A set in
   * memory is empty after a deploy and is not shared between instances; the index is true
   * for all of them at once.
   *
   * A collision is therefore an expected outcome, not an error. It means somebody else has
   * already written this exact intent, so there is nothing to do and nothing to report.
   */
  private async enqueue(
    input: NotifyInput,
    state: { scheduledFor: Date; status: 'PENDING' | 'SCHEDULED' },
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    /*
      Locale is resolved at ENQUEUE time and stored on the row, not resolved again at send
      time. A reminder queued three weeks ago should arrive in the language the person was
      using when it was queued; re-resolving on dispatch would let a preference changed in
      between silently rewrite messages that were already composed.
    */
    const locale = await this.localeFor(input);
    const resolved = await this.resolveChannelKeys(input);
    const db = tx ?? this.prisma;
    const recipientRef = input.userId ?? input.toEmail ?? '';

    const ids: string[] = [];
    for (const key of resolved) {
      const dedupeKey = dedupeKeyFor({
        type: input.type,
        channel: key,
        recipientRef,
        payload: input.payload,
        explicitIntent: input.intentKey,
      });
      try {
        const row = await db.notification.create({
          data: {
            type: input.type,
            userId: input.userId ?? null,
            toEmail: input.toEmail ?? null,
            payload: input.payload as Prisma.InputJsonValue,
            channel: key,
            locale,
            status: state.status,
            scheduledFor: state.scheduledFor,
            dedupeKey,
          },
          select: { id: true },
        });
        ids.push(row.id);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        this.logger.log(`[${key}:${input.type}] already queued for this intent; not duplicated`);
        this.metrics?.recordNotification(key, 'none', 'deduplicated');
      }
    }
    return ids;
  }

  /**
   * Cancels a notification if it is still PENDING or SCHEDULED. Uses an atomic
   * updateMany guard so a row already SENT/FAILED/CANCELLED is untouched.
   * Returns true when a row was cancelled, false otherwise.
   */
  async cancel(notificationId: string): Promise<boolean> {
    const res = await this.prisma.notification.updateMany({
      where: { id: notificationId, status: { in: ['PENDING', 'SCHEDULED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    return res.count === 1;
  }

  /**
   * Deliver every notification that is due -- immediate (PENDING) and scheduled alike.
   *
   * -- WHY PENDING IS SWEPT TOO ------------------------------------------------------
   * PENDING used to be an unreachable status: `send()` created rows as SENT and delivered
   * them in the caller's request, so the only thing this swept was deferred reminders. Now
   * that immediate sends are written down and handed over, this is the ONLY thing that talks
   * to a provider, which is precisely what keeps a provider outage out of the payment path.
   *
   * -- WHAT EACH OUTCOME MEANS -------------------------------------------------------
   * SENT means a provider accepted it, and the provider and its reference are recorded
   * alongside so somebody can later ask that provider what became of it. A skip -- no phone
   * number, no registered device -- is also SENT-with-a-reason rather than FAILED: there was
   * nothing to deliver to, and retrying that twelve times cannot change it. A permanent
   * refusal (no DLT template, no route for the destination) goes straight to FAILED without
   * burning retries, because the next attempt would be refused for the same reason.
   */
  async dispatchDue(now: Date = new Date(), maxAttempts = 3): Promise<DispatchSummary> {
    // Bounded per tick so a large scheduled blast (e.g. a 50k-attendee reminder) can't
    // pull the whole backlog into memory; the remainder waits for the next run.
    const due = await this.prisma.notification.findMany({
      where: { status: { in: ['PENDING', 'SCHEDULED'] }, scheduledFor: { lte: now } },
      orderBy: { scheduledFor: 'asc' },
      take: 500,
    });

    const summary: DispatchSummary = { sent: 0, failed: 0, retried: 0 };
    for (const row of due) {
      const key = row.channel as ChannelKey;
      const channel = this.channels.resolve(row.channel);
      try {
        if (!channel) throw new Error(`Unknown channel "${row.channel}"`);
        const rendered = this.renderFor(
          {
            type: row.type,
            userId: row.userId,
            toEmail: row.toEmail,
            payload: (row.payload as Record<string, unknown>) ?? {},
          },
          key,
          row.locale,
        );
        const outcome = await channel.deliver(rendered);
        await this.prisma.notification.update({
          where: { id: row.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            provider: outcome.provider,
            providerMessageId: outcome.providerMessageId ?? null,
            // A skip records WHY nothing went out. `lastError` is the only free-text field
            // on the row and an operator reading it wants to see "no_destination" there,
            // not an empty column and a status that claims success.
            lastError: outcome.skipped ? (outcome.reason ?? 'skipped') : null,
          },
        });
        summary.sent += 1;
        this.metrics?.recordNotification(
          key,
          outcome.provider,
          outcome.skipped ? 'skipped' : 'sent',
        );
      } catch (err) {
        const attempts = row.attempts + 1;
        // A provider that says "never" is believed the first time.
        const permanent = err instanceof TransportError && !err.retryable;
        const failed = permanent || attempts >= maxAttempts;
        await this.prisma.notification.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: err instanceof Error ? err.message : String(err),
            status: failed ? 'FAILED' : row.status,
          },
        });
        if (failed) {
          summary.failed += 1;
          this.logger.warn(
            `notification ${row.id} failed after ${attempts} attempt(s)` +
              (permanent ? ' (permanent)' : ''),
          );
          this.metrics?.recordNotification(key, 'none', 'failed');
        } else {
          summary.retried += 1;
          this.metrics?.recordNotification(key, 'none', 'retried');
        }
      }
    }
    return summary;
  }

  /** Resolves the effective channel keys for an input, applying preferences. */
  /**
   * In-app notification inbox for a user (WS8): the persisted `in_app` rows,
   * newest first, each rendered to a subject/body via the template service.
   * `before` (a createdAt cursor) pages backwards; `limit` is capped at 50.
   */
  async inbox(
    userId: string,
    opts: { limit?: number; before?: Date; audience?: MessageAudience } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    /*
      Filtering by audience is what stops the organizer console showing its operator's own
      ticket purchases — reported from QA, and caused by keying the inbox on user id alone.
      One person can hold both roles; the streams still belong on different screens.

      Omitting `audience` returns everything, which keeps every existing caller working and
      leaves the door open for a combined view later.
    */
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        channel: 'in_app',
        status: 'SENT',
        ...(opts.audience ? { type: { in: typesForAudience(opts.audience) } } : {}),
        ...(opts.before ? { createdAt: { lt: opts.before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const items = rows.map((row) => {
      const { subject, body } = this.templates.render(
        row.type,
        row.locale,
        (row.payload as Record<string, unknown>) ?? {},
      );
      return {
        id: row.id,
        type: row.type,
        subject,
        body,
        readAt: row.readAt,
        createdAt: row.createdAt,
      };
    });
    return { items, unreadCount: await this.unreadCount(userId) };
  }

  /** Count of unread in-app notifications for a user. */
  /**
   * Unread count, for ONE audience.
   *
   * The inbox learned to filter and this did not, so the customer site's bell counted an
   * organizer's payout notices and event approvals — a badge promising unread messages that
   * the list beneath it correctly refused to show. Two surfaces disagreeing about what the
   * same person has waiting is worse than either being wrong alone.
   */
  async unreadCount(userId: string, audience?: MessageAudience): Promise<number> {
    return this.prisma.notification.count({
      where: {
        userId,
        channel: 'in_app',
        status: 'SENT',
        readAt: null,
        ...(audience ? { type: { in: typesForAudience(audience) } } : {}),
      },
    });
  }

  /** Mark a single in-app notification read (owner-scoped). Returns true if it changed. */
  async markRead(userId: string, id: string): Promise<boolean> {
    const res = await this.prisma.notification.updateMany({
      where: { id, userId, channel: 'in_app', readAt: null },
      data: { readAt: new Date() },
    });
    return res.count === 1;
  }

  /** Mark all of a user's unread in-app notifications read. Returns the count updated. */
  async markAllRead(userId: string, audience?: MessageAudience): Promise<number> {
    /*
      Scoped to the audience the person is looking at. "Mark all read" on the customer site
      used to clear an organizer's payout notices too — the one action where a merged stream
      does not merely show the wrong thing, it destroys the signal that something needed
      attention on a screen the person was not even on.
    */
    const res = await this.prisma.notification.updateMany({
      where: {
        userId,
        channel: 'in_app',
        status: 'SENT',
        readAt: null,
        ...(audience ? { type: { in: typesForAudience(audience) } } : {}),
      },
      data: { readAt: new Date() },
    });
    return res.count;
  }

  private async resolveChannelKeys(input: NotifyInput): Promise<ChannelKey[]> {
    /*
      Policy decides which channels this KIND of message may use; the caller may then ask for
      fewer, never more. That order is what makes fixing the SMS recipient bug safe: before
      this, every type defaulted to the same list, so the moment SMS could actually reach
      somebody, every notification on the platform would have started sending one.
    */
    const requested = permittedChannels(input.type, input.channels);
    const enabled = await this.preferences.resolveChannels(
      input.userId ?? null,
      input.type,
      requested,
    );
    // Drop any unknown channel keys so delivery never dereferences a missing
    // channel; keep declared order.
    const known = enabled.filter((c): c is ChannelKey => this.channels.has(c));

    /*
      A transactional message goes out on every channel the person left enabled. It is
      about a transaction they entered into, and withholding a ticket, a refund
      confirmation or a cancellation because of a marketing preference would be a product
      failure dressed up as a legal precaution.

      A commercial message needs an affirmative consent record per channel, and the
      absence of a record means NO. That default is the whole point: read the other way,
      the first promotional message ever added would go to everyone who ever bought a
      ticket. Filtering here rather than at each call site means a new marketing message
      cannot forget to ask.
    */
    if (isTransactional(input.type)) return known;

    const allowed: ChannelKey[] = [];
    for (const channel of known) {
      const ok = await this.consent.mayReceiveMarketing(
        { userId: input.userId, email: input.toEmail },
        channel,
      );
      if (ok) allowed.push(channel);
    }
    if (allowed.length < known.length) {
      this.logger.log(
        `suppressed ${messageClassOf(input.type)} ${input.type} on ` +
          `${known.length - allowed.length} channel(s): no consent on file`,
      );
    }
    return allowed;
  }

  /** Renders a template for a single channel into a RenderedNotification. */
  private renderFor(
    input: Pick<NotifyInput, 'type' | 'userId' | 'toEmail' | 'payload' | 'country'>,
    channel: ChannelKey,
    locale: string,
  ): RenderedNotification {
    const { subject, body } = this.templates.render(input.type, locale, input.payload);
    return {
      type: input.type,
      channel,
      locale,
      toEmail: input.toEmail ?? null,
      userId: input.userId ?? null,
      subject,
      body,
      payload: input.payload,
      country: input.country ?? null,
    };
  }
}

/**
 * A Prisma unique-constraint violation (P2002).
 *
 * Matched on the code rather than the message so it survives a Prisma upgrade rewording it,
 * and narrowed by shape rather than `instanceof` so it still recognises the error when the
 * throw crosses a transaction client boundary.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
