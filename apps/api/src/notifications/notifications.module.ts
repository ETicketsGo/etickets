import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsController } from './notifications.controller';
import { MarketingConsentController } from './marketing-consent.controller';
import { MarketingConsentService } from './marketing-consent.service';
import { NotificationService } from './notification.service';
import { AdminAudienceService } from './admin-audience.service';
import { WebPushController } from './web-push/web-push.controller';
import { WebPushService } from './web-push/web-push.service';
import { WEB_PUSH_DISPATCHER, selectWebPushDispatcher } from './web-push/web-push.dispatcher';
import { NotificationTemplateService } from './templates/notification-template.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationChannelRegistry } from './channels/notification-channel.registry';
import { NotificationProviderResolver } from './channels/notification-provider.resolver';
import { NotificationPolicyResolver } from './policy/notification-policy.resolver';
import { NotificationFallbackService } from './policy/fallback.service';
import { ShowCancellationFanoutService } from './producers/show-cancellation-fanout.service';
import { ShowCancelledNotificationHandler } from './producers/show-cancelled.handler';
import { ShowReminderService } from './producers/show-reminder.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationReadinessService } from './readiness/notification-readiness.service';
import { MarketCertificationService } from './readiness/market-certification.service';
import { NotificationReadinessController } from './readiness/notification-readiness.controller';
import { NotificationRateService } from './cost/notification-rate.service';
import { NotificationAnalyticsService } from './cost/notification-analytics.service';
import { NotificationAnalyticsController } from './cost/notification-analytics.controller';
import { DeliveryRecorderService } from './delivery/delivery-recorder.service';
import { SuppressionService } from './delivery/suppression.service';
import { NotificationOpsService } from './delivery/notification-ops.service';
import { NotificationOpsController } from './delivery/notification-ops.controller';
import { DeliveryWebhookService } from './delivery/webhook/delivery-webhook.service';
import { SnsVerifier } from './delivery/webhook/sns-verifier';
import { DeliveryWebhookController } from './delivery/webhook/delivery-webhook.controller';
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
  controllers: [
    NotificationsController,
    WebPushController,
    MarketingConsentController,
    NotificationOpsController,
    NotificationAnalyticsController,
    NotificationPreferencesController,
    NotificationReadinessController,
    DeliveryWebhookController,
  ],
  providers: [
    WebPushService,
    { provide: WEB_PUSH_DISPATCHER, inject: [ConfigService], useFactory: selectWebPushDispatcher },
    NotificationService,
    AdminAudienceService,
    MarketingConsentService,
    NotificationTemplateService,
    NotificationPreferencesService,
    NotificationChannelRegistry,
    NotificationProviderResolver,
    // Policy (ADR-047): which channels, for whom -- and no provider names anywhere in it.
    NotificationPolicyResolver,
    NotificationFallbackService,
    // Cost accounting (ADR-048): what a message cost, from a rate in force when it went.
    NotificationRateService,
    NotificationAnalyticsService,
    // Producers (ADR-049): the domain facts that become customer messages.
    ShowCancellationFanoutService,
    ShowCancelledNotificationHandler,
    ShowReminderService,
    NotificationReadinessService,
    MarketCertificationService,
    // Delivery receipts (ADR-046): what the provider said, as distinct from what we sent.
    SuppressionService,
    DeliveryRecorderService,
    DeliveryWebhookService,
    SnsVerifier,
    NotificationOpsService,
    EmailChannel,
    SmsChannel,
    WhatsAppChannel,
    PushChannel,
    InAppChannel,
    /*
      Email and push bind one transport for the whole process, chosen by EMAIL_PROVIDER and
      PUSH_PROVIDER. That remains correct for them: SES serves every market, and a device
      token names its own delivery service.

      SMS and WhatsApp no longer bind here. Their provider depends on where the message is
      going, which is not knowable at boot, so NotificationProviderResolver constructs them
      lazily per route and caches them -- the same lazy-construct-and-cache arrangement that
      lets Stripe and Razorpay run side by side in this process today. The tokens below stay
      bound to the DEFAULT provider so anything still injecting them keeps working.
    */
    { provide: EMAIL_TRANSPORT, inject: [ConfigService], useFactory: selectEmailTransport },
    { provide: SMS_TRANSPORT, inject: [ConfigService], useFactory: selectSmsTransport },
    { provide: WHATSAPP_TRANSPORT, inject: [ConfigService], useFactory: selectWhatsAppTransport },
    { provide: PUSH_TRANSPORT, inject: [ConfigService], useFactory: selectPushTransport },
  ],
  exports: [
    NotificationService,
    // Exported so phone sign-in can deliver an OTP WITHOUT going through
    // `NotificationService`, which would persist the live code in a Notification row.
    SmsChannel,
    NotificationPreferencesService,
    AdminAudienceService,
    MarketingConsentService,
    SuppressionService,
    DeliveryRecorderService,
    NotificationPolicyResolver,
    // Exported so the worker can sweep for fallbacks that are now due.
    NotificationFallbackService,
    NotificationRateService,
    // Exported so the worker can sweep for fan-outs and reminders that are due.
    ShowCancellationFanoutService,
    ShowCancelledNotificationHandler,
    ShowReminderService,
  ],
})
export class NotificationsModule {}
