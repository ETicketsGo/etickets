import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  FeedbackKind,
  NotificationType,
  PUBLISHED_SUPPORT_EMAIL,
  isReservedEmail,
} from '@eticketsgo/shared-types';
import { isLocale } from '@eticketsgo/i18n';
import { NotificationService } from '../notifications/notification.service';
import { isSafeReplyTo } from '../notifications/channels/reply-to';
import { SUPPORT_MESSAGE_EMAIL_MAX } from '../notifications/templates/support-request';

/**
 * The kinds a person writes expecting a PERSON to read and answer.
 *
 * Contact, complaint, bug and feature request all come from a form that says "send", and the
 * organizer console's support requests (legal type changes, "ask ETicketsGo to resume") are
 * CONTACT messages through the same door. They are mailed to support and acknowledged.
 *
 * GENERAL, CSAT and ORGANIZER_CSAT are deliberately absent. They are the "how are we doing"
 * widget and the satisfaction surveys: a star rating with an optional comment, sent many times
 * a day, which nobody asked to be answered. Mailing each one would bury the messages that do
 * need an answer under ratings that do not, and acknowledging a star rating by email is noise.
 * They stay in the admin console, where they are read in aggregate.
 */
export const MAILED_KINDS: ReadonlySet<string> = new Set([
  FeedbackKind.CONTACT,
  FeedbackKind.COMPLAINT,
  FeedbackKind.BUG,
  FeedbackKind.FEATURE,
]);

/**
 * How many acknowledgements one address may be sent in an hour.
 *
 * The acknowledgement goes to whatever address was typed into a public form, so without a cap
 * the form is a way to make us mail a stranger repeatedly. Three an hour covers a person who
 * writes, remembers something, and writes again; past that the message is still stored and
 * still mailed to support - only the "we have it" reply is withheld.
 */
export const ACK_LIMIT_PER_HOUR = 3;

/**
 * True for an address in a domain that can never receive mail (RFC 2606 and RFC 6761).
 *
 * Seed accounts, e2e runs and QA walks write in as `someone@eticketsgo.test` or
 * `x@test.invalid`. An acknowledgement to one of those is a guaranteed bounce, and bounces
 * count against the sending domain's reputation with SES. The message itself is still stored
 * and still copied to the support inbox; only the reply that could never arrive is skipped.
 */
export function isUndeliverableDomain(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  const tld = domain.split('.').pop() ?? '';
  return (
    ['test', 'invalid', 'example', 'localhost'].includes(tld) ||
    ['example.com', 'example.net', 'example.org'].includes(domain)
  );
}

/** What the mailbox copy and the acknowledgement need to know about one submission. */
export interface SupportMailInput {
  feedbackId: string;
  kind: string;
  /** Where replies go: the signed-in account's address, or the one typed into the form. */
  replyTo: string | null;
  senderName: string | null;
  accountEmail: string | null;
  userId: string | null;
  organizationName: string | null;
  bookingReference: string | null;
  topic: string | null;
  message: string;
  locale: string | null;
}

/**
 * Mails a support-form message to the support mailbox, and says "we have it" to the sender.
 *
 * ── WHY THROUGH THE NOTIFICATION OUTBOX ────────────────────────────────────────────
 * Both mails are rows written in the SAME transaction as the submission, and the worker
 * delivers them. Nothing here talks to a mail provider, so an SES outage cannot fail the form:
 * the person still gets their 201, the message is still in the admin console, and the worker
 * retries the mail on its usual schedule. A crash between storing the message and queueing
 * the mail cannot lose the mail either, because they commit together.
 *
 * ── WHY A RETRY CANNOT SEND TWICE ──────────────────────────────────────────────────
 * Each mail carries an intent key made from the submission's id, so the unique dedupe index
 * holds one row per submission per mail, whatever re-runs this. A form submitted twice is
 * caught before this, in SupportService, and never reaches here a second time.
 */
@Injectable()
export class SupportMailService {
  private readonly logger = new Logger('SupportMail');

  constructor(
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The mailbox form messages are copied to here, or null for none.
   *
   * ── THE RULE ───────────────────────────────────────────────────────────────────────
   * An explicit SUPPORT_INBOX_EMAIL wins everywhere. Without one, production mails the
   * published support address and every other environment mails no inbox at all. QA and UAT
   * are where people type "test test test" into the contact form; with a default, every one of
   * those would land in the real support mailbox and teach the team to ignore it.
   *
   * Production needs no variable for this to work, so turning it on changes no production
   * configuration.
   */
  inboxAddress(): string | null {
    const override = this.config.get<string>('SUPPORT_INBOX_EMAIL')?.trim();
    if (override) {
      if (isSafeReplyTo(override)) return override.toLowerCase();
      this.logger.warn('SUPPORT_INBOX_EMAIL is not a plain email address; ignored.');
    }
    const appEnv = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    return appEnv === 'PRODUCTION' ? PUBLISHED_SUPPORT_EMAIL : null;
  }

  /**
   * The admin console page for this message, or null when this deployment has no admin URL.
   *
   * The inbox search matches a submission's id exactly, so the link opens a list of one.
   * Missing configuration costs the button, never the mail.
   */
  private adminLink(feedbackId: string): string | null {
    const configured = this.config.get<string>('ADMIN_WEB_URL')?.trim().replace(/\/+$/, '');
    const appEnv = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    const base = configured || (['LOCAL', 'DEV'].includes(appEnv) ? 'http://localhost:3002' : null);
    return base ? `${base}/admin/support?q=${encodeURIComponent(feedbackId)}` : null;
  }

  /** Queue both mails inside the submission's transaction. Writes rows; sends nothing. */
  async queue(tx: Prisma.TransactionClient, input: SupportMailInput): Promise<void> {
    if (!MAILED_KINDS.has(input.kind)) return;

    // A Reply-To that is not a plain address is dropped, never "cleaned up" into one.
    const replyTo = input.replyTo && isSafeReplyTo(input.replyTo) ? input.replyTo : null;
    const inbox = this.inboxAddress();
    const intent = `support-request:${input.feedbackId}`;

    if (inbox) {
      const truncated = input.message.length > SUPPORT_MESSAGE_EMAIL_MAX;
      await this.notifications.send(
        {
          type: NotificationType.SUPPORT_REQUEST_RECEIVED,
          // The mailbox has no account. Written in English: it is read by the support team.
          userId: null,
          toEmail: inbox,
          channels: ['email'],
          locale: 'en',
          intentKey: intent,
          payload: {
            reference: input.feedbackId,
            kind: input.kind,
            topic: input.topic ?? '',
            message: truncated ? input.message.slice(0, SUPPORT_MESSAGE_EMAIL_MAX) : input.message,
            truncated,
            senderName: input.senderName ?? '',
            replyTo: replyTo ?? '',
            accountEmail: input.accountEmail ?? '',
            organizationName: input.organizationName ?? '',
            bookingReference: input.bookingReference ?? '',
            link: this.adminLink(input.feedbackId) ?? '',
          },
        },
        tx,
      );
    } else {
      this.logger.log(
        `support message ${input.feedbackId} stored; no support inbox in this environment ` +
          `(set SUPPORT_INBOX_EMAIL to mail one)`,
      );
    }

    if (!replyTo) return;
    /*
      The acknowledgement cap, counted from the outbox itself so it holds across instances and
      restarts. A phone-only placeholder never gets here: isSafeReplyTo refuses reserved
      addresses, and the email channel would skip it anyway.
    */
    if (isReservedEmail(replyTo)) return;
    if (isUndeliverableDomain(replyTo)) {
      this.logger.log(
        `support message ${input.feedbackId}: no acknowledgement, the address is in a test domain`,
      );
      return;
    }
    const recent = await tx.notification.count({
      where: {
        type: NotificationType.SUPPORT_REQUEST_ACKNOWLEDGED,
        toEmail: replyTo,
        createdAt: { gte: new Date(Date.now() - 60 * 60_000) },
      },
    });
    if (recent >= ACK_LIMIT_PER_HOUR) {
      this.logger.warn(
        `support message ${input.feedbackId}: acknowledgement withheld, ` +
          `${recent} already sent to this address in the last hour`,
      );
      return;
    }

    await this.notifications.send(
      {
        type: NotificationType.SUPPORT_REQUEST_ACKNOWLEDGED,
        userId: input.userId,
        toEmail: replyTo,
        channels: ['email'],
        // The form's language when it said one; otherwise the account's, otherwise English.
        ...(input.locale && isLocale(input.locale) ? { locale: input.locale } : {}),
        intentKey: intent,
        payload: {
          reference: input.feedbackId,
          email: replyTo,
          // A reply to the acknowledgement reaches support rather than the no-reply sender.
          ...(inbox ? { replyTo: inbox } : {}),
        },
      },
      tx,
    );
  }
}
