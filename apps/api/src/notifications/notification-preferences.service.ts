import { Injectable } from '@nestjs/common';
import { NotificationType } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Per-user channel opt-outs. Absence of a NotificationPreference row means the
 * channel is enabled; a row with enabled=false is an opt-out.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Filters `requested` channels down to those the user has NOT disabled.
   * - Null userId (guest): requested channels pass through unchanged.
   * - No rows for the user/type: all requested channels are enabled.
   * - A row with enabled=false removes that channel.
   */
  async resolveChannels(
    userId: string | null,
    type: NotificationType,
    requested: string[],
  ): Promise<string[]> {
    if (!userId) return requested;

    const prefs = await this.prisma.notificationPreference.findMany({
      where: { userId, type, channel: { in: requested } },
    });
    const disabled = new Set(prefs.filter((p) => !p.enabled).map((p) => p.channel));
    return requested.filter((c) => !disabled.has(c));
  }

  /** Upserts a single (user, type, channel) preference. */
  async setPreference(userId: string, type: NotificationType, channel: string, enabled: boolean) {
    return this.prisma.notificationPreference.upsert({
      where: { userId_type_channel: { userId, type, channel } },
      create: { userId, type, channel, enabled },
      update: { enabled },
    });
  }

  /** Lists all preference rows for a user. */
  async list(userId: string) {
    return this.prisma.notificationPreference.findMany({ where: { userId } });
  }
}
