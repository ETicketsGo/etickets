import { Injectable } from '@nestjs/common';
import { ChannelKey, NotificationChannel } from './notification-channel.interface';
import { EmailChannel } from './email.channel';
import { SmsChannel } from './sms.channel';
import { WhatsAppChannel } from './whatsapp.channel';
import { PushChannel } from './push.channel';
import { InAppChannel } from './in-app.channel';

/**
 * Resolves a {@link NotificationChannel} implementation by its key. Channels are
 * injected and indexed once at construction; new channels are added by binding
 * them here and in the module providers.
 */
@Injectable()
export class NotificationChannelRegistry {
  private readonly channels: Map<ChannelKey, NotificationChannel>;

  constructor(
    email: EmailChannel,
    sms: SmsChannel,
    whatsapp: WhatsAppChannel,
    push: PushChannel,
    inApp: InAppChannel,
  ) {
    const all: NotificationChannel[] = [email, sms, whatsapp, push, inApp];
    this.channels = new Map(all.map((c) => [c.key, c]));
  }

  /** Returns true when `key` maps to a known channel. */
  has(key: string): key is ChannelKey {
    return this.channels.has(key as ChannelKey);
  }

  /** Resolves a channel by key, or undefined when the key is unknown. */
  resolve(key: string): NotificationChannel | undefined {
    return this.channels.get(key as ChannelKey);
  }

  /** All registered channel keys. */
  keys(): ChannelKey[] {
    return [...this.channels.keys()];
  }
}
