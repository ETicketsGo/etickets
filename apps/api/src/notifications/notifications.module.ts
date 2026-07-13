import { Global, Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationTemplateService } from './templates/notification-template.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationChannelRegistry } from './channels/notification-channel.registry';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { WhatsAppChannel } from './channels/whatsapp.channel';
import { PushChannel } from './channels/push.channel';
import { InAppChannel } from './channels/in-app.channel';

@Global()
@Module({
  providers: [
    NotificationService,
    NotificationTemplateService,
    NotificationPreferencesService,
    NotificationChannelRegistry,
    EmailChannel,
    SmsChannel,
    WhatsAppChannel,
    PushChannel,
    InAppChannel,
  ],
  exports: [NotificationService, NotificationPreferencesService],
})
export class NotificationsModule {}
