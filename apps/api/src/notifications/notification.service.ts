import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationTemplateService } from './templates/notification-template.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationChannelRegistry } from './channels/notification-channel.registry';
import { ChannelKey, RenderedNotification } from './channels/notification-channel.interface';

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
}

/** Outcome counts from a scheduled-dispatch sweep. */
export interface DispatchSummary {
  sent: number;
  failed: number;
  retried: number;
}

const DEFAULT_CHANNELS = ['email'];
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
  ) {}

  /**
   * Sends a notification immediately. Resolves channels (default `['email']`)
   * filtered by user preferences, renders a per-channel template, then for EACH
   * channel persists a SENT row and delivers via the channel.
   */
  async send(input: NotifyInput): Promise<void> {
    const locale = input.locale ?? DEFAULT_LOCALE;
    const resolved = await this.resolveChannelKeys(input);

    for (const key of resolved) {
      const rendered = this.renderFor(input, key, locale);
      await this.prisma.notification.create({
        data: {
          type: input.type,
          userId: input.userId ?? null,
          toEmail: input.toEmail ?? null,
          payload: input.payload as Prisma.InputJsonValue,
          channel: key,
          locale,
          status: 'SENT',
          sentAt: new Date(),
        },
      });
      await this.channels.resolve(key)!.deliver(rendered);
    }
  }

  /**
   * Persists a notification per resolved channel with status SCHEDULED and the
   * given `scheduledFor`, WITHOUT delivering. Returns the created row ids.
   */
  async schedule(input: NotifyInput, scheduledFor: Date): Promise<string[]> {
    const locale = input.locale ?? DEFAULT_LOCALE;
    const resolved = await this.resolveChannelKeys(input);

    const ids: string[] = [];
    for (const key of resolved) {
      const row = await this.prisma.notification.create({
        data: {
          type: input.type,
          userId: input.userId ?? null,
          toEmail: input.toEmail ?? null,
          payload: input.payload as Prisma.InputJsonValue,
          channel: key,
          locale,
          status: 'SCHEDULED',
          scheduledFor,
        },
      });
      ids.push(row.id);
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
   * Delivers all SCHEDULED notifications due at/before `now`. On success a row
   * becomes SENT; on error attempts is incremented and lastError recorded, with
   * the row marked FAILED only once attempts >= maxAttempts (otherwise it stays
   * SCHEDULED for a later retry).
   */
  async dispatchDue(now: Date = new Date(), maxAttempts = 3): Promise<DispatchSummary> {
    // Bounded per tick so a large scheduled blast (e.g. a 50k-attendee reminder) can't
    // pull the whole backlog into memory; the remainder stays SCHEDULED for the next run.
    const due = await this.prisma.notification.findMany({
      where: { status: 'SCHEDULED', scheduledFor: { lte: now } },
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
        await channel.deliver(rendered);
        await this.prisma.notification.update({
          where: { id: row.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
        summary.sent += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const failed = attempts >= maxAttempts;
        await this.prisma.notification.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: err instanceof Error ? err.message : String(err),
            status: failed ? 'FAILED' : 'SCHEDULED',
          },
        });
        if (failed) {
          summary.failed += 1;
          this.logger.warn(`notification ${row.id} failed after ${attempts} attempt(s)`);
        } else {
          summary.retried += 1;
        }
      }
    }
    return summary;
  }

  /** Resolves the effective channel keys for an input, applying preferences. */
  private async resolveChannelKeys(input: NotifyInput): Promise<ChannelKey[]> {
    const requested = input.channels ?? DEFAULT_CHANNELS;
    const enabled = await this.preferences.resolveChannels(
      input.userId ?? null,
      input.type,
      requested,
    );
    // Drop any unknown channel keys so delivery never dereferences a missing
    // channel; keep declared order.
    return enabled.filter((c): c is ChannelKey => this.channels.has(c));
  }

  /** Renders a template for a single channel into a RenderedNotification. */
  private renderFor(
    input: Pick<NotifyInput, 'type' | 'userId' | 'toEmail' | 'payload'>,
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
    };
  }
}
