import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from './notification.service';
import { NotificationTemplateService } from './templates/notification-template.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationChannelRegistry } from './channels/notification-channel.registry';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { WhatsAppChannel } from './channels/whatsapp.channel';
import { PushChannel } from './channels/push.channel';
import { InAppChannel } from './channels/in-app.channel';
import { EMAIL_TRANSPORT, selectEmailTransport } from './channels/transports/email.transport';
import { SMS_TRANSPORT, selectSmsTransport } from './channels/transports/sms.transport';
import {
  WHATSAPP_TRANSPORT,
  selectWhatsAppTransport,
} from './channels/transports/whatsapp.transport';
import { PUSH_TRANSPORT, selectPushTransport } from './channels/transports/push.transport';

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
    // Per-channel delivery transport, keyed on <CHANNEL>_PROVIDER (default `log`).
    // Only the selected provider is constructed, so real credentials are never
    // required unless that provider is chosen, and a selected provider with
    // missing keys fails fast at construction.
    { provide: EMAIL_TRANSPORT, inject: [ConfigService], useFactory: selectEmailTransport },
    { provide: SMS_TRANSPORT, inject: [ConfigService], useFactory: selectSmsTransport },
    { provide: WHATSAPP_TRANSPORT, inject: [ConfigService], useFactory: selectWhatsAppTransport },
    { provide: PUSH_TRANSPORT, inject: [ConfigService], useFactory: selectPushTransport },
  ],
  exports: [NotificationService, NotificationPreferencesService],
})
export class NotificationsModule {}
