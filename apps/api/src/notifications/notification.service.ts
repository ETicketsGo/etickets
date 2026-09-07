import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, OutcomeClass, SendKind } from '@eticketsgo/shared-types';
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
import { isCritical, permittedChannels } from './policy/channel-policy';
import { NotificationPolicyResolver } from './policy/notification-policy.resolver';
import { dedupeKeyFor, intentKeyFor } from './policy/dedupe-key';
import { MetricsService } from '../metrics/metrics.service';
import { TransportError } from './channels/transports/transport-http';
import { DeliveryRecorderService } from './delivery/delivery-recorder.service';
import { SuppressionService } from './delivery/suppression.service';
import { resolvePhoneDestination } from './channels/phone-destination';

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
  /**
   * The booking this message is about, when it is about one.
   *
   * A column rather than a payload field, because "what do notifications cost per booking"
   * has to join -- and a JSON extraction over every row of the largest table on the platform
   * is not a query anybody wants to run monthly.
   */
  bookingId?: string | null;
  /**
   * Why this send is happening: PRIMARY | RETRY | FALLBACK | MANUAL_RESEND.
   *
   * Cost reporting is why it exists. A fallback SMS and an ordinary confirmation email are
   * both "notification cost" and nothing else about them is alike.
   */
  sendReason?: SendKind;
  /**
   * Permit the channel policy holds back as a fallback.
   *
   * A fallback channel is in the policy -- it has to be, before anything may use it -- but
   * `immediateChannels` withholds it, because permitting is not scheduling. Only
   * NotificationFallbackService sets this, after its wait has elapsed with nothing
   * effective. Without the flag an ordinary caller cannot reach a deferred channel even by
   * naming it, which is what stops a cancelled show sending an SMS the instant it happens.
   */
  allowDeferredChannel?: boolean;
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
    /*
      Optional so the twenty-odd suites that construct this service directly keep working.
      Without them delivery still happens and is still truthful -- it simply is not recorded
      per attempt and nothing is suppressed, which is exactly the Phase 1 behaviour.
    */
    private readonly deliveries?: DeliveryRecorderService,
    private readonly suppression?: SuppressionService,
    /*
      Optional for the same reason the two above are: a great many suites construct this
      service directly. Without it the Phase 1 resolution runs -- policy plus preferences
      plus marketing consent -- which is what those suites were written against.
    */
    private readonly policy?: NotificationPolicyResolver,
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
    if (isCritical(input.type) && !tx) {
      /*
        Loud, and then it writes the row anyway.

        This is the guard for the case `sendCritical` cannot cover: somebody reaches the
        general method with a critical type, perhaps through a helper that takes the type as
        a variable. Throwing here would turn a missing transaction into a failed payment,
        which is the exact class of harm this whole phase removed. So the message is never
        lost -- it is simply enqueued after the commit, with the weaker guarantee, and said
        out loud so it is fixed rather than discovered later.
      */
      this.logger.error(
        `${input.type} was enqueued OUTSIDE a transaction. Use sendCritical(tx, input) so ` +
          `the notification commits with the domain change it describes.`,
      );
    }
    await this.enqueue(input, { scheduledFor: new Date(), status: 'PENDING' }, tx);
  }

  /**
   * Record a critical notification IN the transaction that makes the fact true.
   *
   * -- THE WINDOW THIS CLOSES -------------------------------------------------------
   * Moving delivery to the worker took the provider off the payment path, but left the
   * enqueue after the commit. Between those two statements there is a crash window: the
   * booking is confirmed, the money is taken, the process dies, and the confirmation
   * that would have carried the ticket was never written down. Nothing retries it,
   * because nothing recorded that it was owed. It is rare and it is permanent, which is
   * the worst combination a customer-facing message can have.
   *
   * Written inside the transaction, the invariant is absolute in both directions: if the
   * domain transition commits, its notification intent exists; if it rolls back, the
   * intent does not.
   *
   * -- WHY THE TRANSACTION IS THE FIRST ARGUMENT ------------------------------------
   * Because it cannot then be forgotten. An optional trailing `tx?` is a guarantee that
   * depends on every future developer remembering it, which is not a guarantee. This
   * signature makes omitting it a compile error.
   *
   * -- WHAT IS STILL NOT IN THE TRANSACTION ------------------------------------------
   * Any provider. This writes rows. Delivery stays with the worker exactly as before, so
   * the transaction never waits on a network call and an outage still cannot roll back a
   * payment.
   */
  async sendCritical(tx: Prisma.TransactionClient, input: NotifyInput): Promise<void> {
    await this.enqueue(input, { scheduledFor: new Date(), status: 'PENDING' }, tx);
  }

  /**
   * One fact, many people, one statement.
   *
   * -- WHY THIS IS NOT A LOOP OVER sendCritical -------------------------------------
   * A show with two hundred bookings on four channels is eight hundred rows. Written one
   * at a time inside the transaction that is also holding a screen row lock, that is eight
   * hundred round trips with a scheduling lock held throughout, and every other show on
   * that screen waits behind it. So preferences and locales are read once for the whole
   * audience, the rows are built in memory, and they go in as a single `createMany`.
   *
   * `skipDuplicates` is what makes redelivery safe: the unique index on `dedupeKey` would
   * otherwise abort the entire statement -- and with it the domain change -- because one
   * recipient had already been told. Here the already-told rows are simply not written,
   * which is the correct outcome for all of them at once.
   *
   * Consent is not consulted, and does not need to be: fan-out is for TRANSACTIONAL facts
   * about a booking somebody already holds, and {@link resolveChannelKeys} would reach the
   * same conclusion one row at a time.
   */
  async fanOutCritical(
    tx: Prisma.TransactionClient,
    input: {
      type: NotificationType;
      /*
        Each recipient carries its OWN payload rather than the caller supplying a lookup.

        One person can hold two bookings on the same show. With a shared payload, or a
        payload resolved by matching on who the recipient is, both of their messages would
        name the same booking -- and, because the booking id is part of the dedupe subject,
        the second would be discarded as a duplicate of the first. Two bookings affected by
        a change are two things to be told.
      */
      recipients: {
        userId: string | null;
        toEmail: string | null;
        payload: Record<string, unknown>;
      }[];
      country?: string | null;
    },
  ): Promise<number> {
    if (input.recipients.length === 0) return 0;
    if (!isTransactional(input.type)) {
      // A commercial message needs a consent record per person per channel, which is a
      // per-recipient decision this bulk path deliberately does not make.
      throw new Error(`fanOutCritical is for transactional messages; ${input.type} is not one.`);
    }

    const channels = permittedChannels(input.type).filter((c) => this.channels.has(c));
    const userIds = input.recipients.map((r) => r.userId).filter((id): id is string => Boolean(id));

    // Two reads for the whole audience, however large it is.
    const [users, prefs] = await Promise.all([
      userIds.length
        ? tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, locale: true } })
        : Promise.resolve([] as { id: string; locale: string | null }[]),
      userIds.length
        ? tx.notificationPreference.findMany({
            where: { userId: { in: userIds }, type: input.type, enabled: false },
            select: { userId: true, channel: true },
          })
        : Promise.resolve([] as { userId: string; channel: string }[]),
    ]);
    const localeOf = new Map(users.map((u) => [u.id, u.locale ?? DEFAULT_LOCALE]));
    const optedOut = new Set(prefs.map((p) => `${p.userId}:${p.channel}`));

    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const recipient of input.recipients) {
      const payload = recipient.payload;
      const locale = recipient.userId
        ? (localeOf.get(recipient.userId) ?? DEFAULT_LOCALE)
        : DEFAULT_LOCALE;
      for (const channel of channels) {
        if (recipient.userId && optedOut.has(`${recipient.userId}:${channel}`)) continue;
        rows.push({
          type: input.type,
          userId: recipient.userId,
          toEmail: recipient.toEmail,
          payload: payload as Prisma.InputJsonValue,
          channel,
          locale,
          status: 'PENDING',
          scheduledFor: new Date(),
          dedupeKey: dedupeKeyFor({
            type: input.type,
            channel,
            recipientRef: recipient.userId ?? recipient.toEmail ?? '',
            payload,
          }),
          intentKey: intentKeyFor({
            type: input.type,
            recipientRef: recipient.userId ?? recipient.toEmail ?? '',
            payload,
          }),
          bookingId: bookingIdFrom(payload),
          sendReason: SendKind.PRIMARY,
        });
      }
    }
    if (rows.length === 0) return 0;
    const created = await tx.notification.createMany({ data: rows, skipDuplicates: true });
    return created.count;
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
   * -- WHY THE COLLISION MUST NOT BE ALLOWED TO RAISE --------------------------------
   * This was originally a plain insert with the unique violation caught in JavaScript, and
   * the integration test found what that actually does. Catching a constraint violation does
   * not un-abort the PostgreSQL transaction it happened in: once the statement fails the
   * whole transaction is poisoned, and the commit becomes a rollback. So a redelivered
   * webhook -- whose notification had already been written -- would have silently DISCARDED
   * the booking confirmation, the tickets and the receipt that had just been written
   * alongside it, and reported success. Idempotency would have destroyed committed work.
   *
   * So a dedupable insert goes through `createMany({ skipDuplicates: true })`, which is
   * `ON CONFLICT DO NOTHING` at the database and never raises. A collision is then what it
   * should always have been: nothing happened, and the transaction is untouched.
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
      // The same identity WITHOUT the channel: what ties one intent's rows together, and the
      // only way a fallback can ask "did ANY preferred channel get through".
      const intentKey = intentKeyFor({
        type: input.type,
        recipientRef,
        payload: input.payload,
        explicitIntent: input.intentKey,
      });
      const data: Prisma.NotificationCreateManyInput = {
        type: input.type,
        userId: input.userId ?? null,
        toEmail: input.toEmail ?? null,
        payload: input.payload as Prisma.InputJsonValue,
        channel: key,
        locale,
        status: state.status,
        scheduledFor: state.scheduledFor,
        dedupeKey,
        intentKey,
        bookingId: input.bookingId ?? bookingIdFrom(input.payload),
        sendReason: input.sendReason ?? SendKind.PRIMARY,
      };

      if (!dedupeKey) {
        // No key, so no index to conflict with: a plain insert cannot poison a transaction,
        // and it hands back the id that `schedule()` needs in order to cancel later.
        const row = await db.notification.create({ data, select: { id: true } });
        ids.push(row.id);
        continue;
      }

      const created = await db.notification.createMany({ data: [data], skipDuplicates: true });
      if (created.count === 0) {
        this.logger.log(`[${key}:${input.type}] already queued for this intent; not duplicated`);
        this.metrics?.recordNotification(key, 'none', 'deduplicated');
        continue;
      }
      // `createMany` returns a count, not rows. The id is only looked up when one was
      // actually written, and the dedupe key is unique, so this finds exactly it.
      const row = await db.notification.findFirst({ where: { dedupeKey }, select: { id: true } });
      if (row) ids.push(row.id);
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
      let deliveryId: string | null = null;
      /*
        Why this send is happening, which is the difference between a cost we planned and one
        we chose. A fallback SMS is the most expensive message this platform sends and an
        operator resend is support spending money on somebody's behalf; both vanish into a
        total that lumps them in with a first attempt. The notification records the reason
        when it is created and the attempt inherits it, rather than guessing from a counter.
      */
      const kind = (row.sendReason as SendKind | null) ?? undefined;
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

        /*
          Is this destination still usable?

          Checked here rather than at enqueue because a destination can go bad between the
          two -- a booking confirmed on Monday and a reminder queued for Friday, with a hard
          bounce in between. Suppression is about whether the address WORKS, so unlike
          consent it stops transactional messages too: continuing to email an address that
          hard-bounces is what gets a sending domain throttled by SES.
        */
        const suppressed = await this.isSuppressed(key, rendered);
        if (suppressed) {
          await this.prisma.notification.update({
            where: { id: row.id },
            data: { status: 'FAILED', lastError: 'destination_suppressed' },
          });
          summary.failed += 1;
          this.metrics?.recordNotification(key, 'none', 'suppressed');
          continue;
        }

        /*
          The attempt is opened BEFORE the provider is called, and that order is the whole
          point. Written afterwards, a crash mid-call leaves no trace and the next sweep
          sends again believing it is the first attempt. Written first, an ATTEMPTING row is
          the honest record of "we do not know whether this went out".
        */
        deliveryId = await this.openAttempt(row.id, key, row.attempts + 1, kind);

        const outcome = await channel.deliver(rendered);
        if (deliveryId) {
          if (outcome.skipped) {
            await this.deliveries?.skipped(
              deliveryId,
              outcome.provider,
              outcome.reason ?? 'skipped',
            );
            this.metrics?.recordNotificationAttempt(
              key,
              outcome.provider,
              OutcomeClass.NO_DESTINATION,
            );
          } else {
            /*
              The rendered body travels to pricing because one logical SMS is not one billed
              SMS: a 200-character message is two segments, and the same message with a rupee
              sign in it is Unicode and three. Without it, every long or non-Latin message
              would be priced as one and the India bill would come as a surprise.
            */
            await this.deliveries?.accepted(
              deliveryId,
              outcome.provider,
              outcome.providerMessageId ?? null,
              { country: rendered.country, body: rendered.body },
            );
            this.metrics?.recordNotificationAttempt(
              key,
              outcome.provider,
              OutcomeClass.PROVIDER_ACCEPTED,
            );
          }
        }
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
        if (deliveryId) {
          await this.deliveries
            ?.failed(deliveryId, 'none', err instanceof Error ? err.message : String(err))
            .catch(() => undefined);
          this.metrics?.recordNotificationAttempt(key, 'none', OutcomeClass.PROVIDER_UNAVAILABLE);
        }
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

  /**
   * Whether the destination this message is going to has been blocked.
   *
   * Email reads the recipient off the row. SMS and WhatsApp have to resolve the number the
   * same way the channel will -- from the recipient's own account -- because that is the
   * destination that will actually be dialled, and checking anything else would check an
   * address the message is not going to.
   *
   * Push is not checked: a device token is not a destination somebody can bounce or opt out
   * of, and a dead token is handled by the transport unregistering it.
   */
  private async isSuppressed(
    channel: ChannelKey,
    rendered: RenderedNotification,
  ): Promise<boolean> {
    if (!this.suppression) return false;
    if (channel === 'email') return this.suppression.isSuppressed('email', rendered.toEmail);
    if (channel !== 'sms' && channel !== 'whatsapp') return false;
    const addressed = await resolvePhoneDestination(rendered, this.prisma);
    return this.suppression.isSuppressed(channel, addressed.destination);
  }

  /** Open a delivery attempt, tolerating the recorder being absent in unit fixtures. */
  private async openAttempt(
    notificationId: string,
    channel: ChannelKey,
    attemptNumber: number,
    sendKind?: SendKind,
  ): Promise<string | null> {
    if (!this.deliveries) return null;
    return this.deliveries
      .open({ notificationId, provider: 'pending', channel, attemptNumber, sendKind })
      .catch(() => null);
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
      One resolver answers the whole product question -- policy, then preference, then
      consent -- and knows no provider names. Which vendor carries the resulting channel is
      decided per message, later, from the destination.
    */
    if (this.policy) {
      const resolved = await this.policy.resolve({
        type: input.type,
        recipient: { userId: input.userId, email: input.toEmail },
        requested: input.channels,
        known: (c) => this.channels.has(c),
        allowDeferred: input.allowDeferredChannel === true,
      });
      return resolved.channels;
    }

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
 * The booking a payload is about, when it names one.
 *
 * Sixteen services already put `bookingId` in their payloads, so lifting it into a column
 * costs nothing at the call sites and turns cost-per-booking from a JSON extraction over
 * millions of rows into an indexed join. A caller may pass `bookingId` explicitly when its
 * payload does not carry one.
 */
function bookingIdFrom(payload: Record<string, unknown> | undefined): string | null {
  const id = payload?.['bookingId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}
