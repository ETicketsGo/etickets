import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
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
import { ProviderEventReplayService } from './delivery/webhook/provider-event-replay.service';
import { SnsVerifier } from './delivery/webhook/sns-verifier';
import { DeliveryWebhookController } from './delivery/webhook/delivery-webhook.controller';
import { SnsBodyMiddleware, applySnsBodyParser } from './delivery/webhook/sns-body.middleware';
import { SnsConfirmationService } from './delivery/webhook/sns-confirmation.service';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { WhatsAppChannel } from './channels/whatsapp.channel';
import { PushChannel } from './channels/push.channel';
import { InAppChannel } from './channels/in-app.channel';
import { EMAIL_TRANSPORT, selectEmailTransport } from './channels/transports/email.transport';
import { TemplateBindingService } from './templates/template-binding.service';
import { TemplateReportService } from './templates/template-report.service';
import { NotificationDiagnosticsService } from './readiness/notification-diagnostics.service';
import { CertificationEvidenceService } from './readiness/certification-evidence.service';
import { SMS_TRANSPORT, selectSmsTransport } from './channels/transports/sms.transport';
import {
  WHATSAPP_TRANSPORT,
  selectWhatsAppTransport,
} from './channels/transports/whatsapp.transport';
import { PUSH_TRANSPORT, selectPushTransport } from './channels/transports/push.transport';

@Global()
@Module({
  /*
    ── ORDER MATTERS HERE ─────────────────────────────────────────────────────────────
    Express matches routes in the order they are registered, and Nest registers controllers in
    the order listed. `NotificationOpsController` owns `GET admin/notifications/:id`, so any
    controller mounted UNDER that prefix must come first — otherwise its bare route is a
    notification id to the ops controller. That is exactly how
    `GET admin/notifications/readiness` answered 404: "readiness" was looked up as a
    notification. The readiness and analytics controllers are therefore listed before ops, and
    `admin-notification-routes.spec.ts` fails if they are ever moved back.
  */
  controllers: [
    NotificationsController,
    WebPushController,
    MarketingConsentController,
    NotificationReadinessController,
    NotificationAnalyticsController,
    NotificationOpsController,
    NotificationPreferencesController,
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
    ProviderEventReplayService,
    SnsVerifier,
    SnsBodyMiddleware,
    SnsConfirmationService,
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
    TemplateBindingService,
    TemplateReportService,
    NotificationDiagnosticsService,
    CertificationEvidenceService,
    { provide: EMAIL_TRANSPORT, inject: [ConfigService], useFactory: selectEmailTransport },
    { provide: SMS_TRANSPORT, inject: [ConfigService], useFactory: selectSmsTransport },
    { provide: WHATSAPP_TRANSPORT, inject: [ConfigService], useFactory: selectWhatsAppTransport },
    { provide: PUSH_TRANSPORT, inject: [ConfigService], useFactory: selectPushTransport },
  ],
  exports: [
    NotificationService,
    TemplateBindingService,
    CertificationEvidenceService,
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
    // Exported so the worker can apply callbacks that arrived before their message was recorded.
    ProviderEventReplayService,
    NotificationRateService,
    // Exported so the worker can sweep for fan-outs and reminders that are due.
    ShowCancellationFanoutService,
    ShowCancelledNotificationHandler,
    ShowReminderService,
  ],
})
export class NotificationsModule implements NestModule {
  /**
   * SNS posts its notifications as `text/plain`, which the global JSON parser declines.
   *
   * Without this the SES webhook received an unparsed body and answered 500 to every genuine
   * message Amazon sent — including the SubscriptionConfirmation, so the subscription could
   * never be created in the first place. The parser is bound to that one route; see
   * `sns-body.middleware.ts` for why it is not simply added to the global parser.
   */
  configure(consumer: MiddlewareConsumer): void {
    applySnsBodyParser(consumer);
  }
}
