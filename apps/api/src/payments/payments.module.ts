import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MockPaymentProvider } from './provider/mock-payment.provider';
import { PAYMENT_PROVIDER } from './provider/payment-provider.interface';
import { selectPaymentProvider } from './provider/payment-provider.factory';
import { PaymentConfigModule } from './configuration/payment-config.module';
import { PaymentProviderRegistry } from './orchestration/provider-registry';
import { PaymentOrchestrator } from './orchestration/payment-orchestrator.service';
import { PaymentProviderFactory } from './provider/factory/payment-provider.factory';
import { MerchantOnboardingController } from './onboarding/merchant-onboarding.controller';
import { MerchantOnboardingService } from './onboarding/merchant-onboarding.service';
import { PromotionController } from './promotion/promotion.controller';
import { PromotionService } from './promotion/promotion.service';
import { SandboxCertificationService } from './certification/sandbox-certification.service';
import { PaymentLiveReadinessService } from './readiness/payment-live-readiness.service';
import { FinanceReconciliationController } from './finance/finance-reconciliation.controller';
import { FinanceReconciliationService } from './finance/finance-reconciliation.service';
import { PaymentOutageController } from './outage/payment-outage.controller';
import { PaymentOutageService } from './outage/payment-outage.service';
import { LaunchGateService } from './launch/launch-gate.service';
import { OpsModule } from '../ops/ops.module';
import { PaymentAdminController } from './admin/payment-admin.controller';
import { PaymentAdminService } from './admin/payment-admin.service';
import { WebhookRouter } from './webhooks/webhook-router.service';
import { PaymentReconciliationService } from './reconciliation/payment-reconciliation.service';
import { OrganizerConnectController } from './connect/organizer-connect.controller';
import { OrganizerConnectService } from './connect/organizer-connect.service';
import { StripeWebhookController } from './webhooks/stripe/stripe-webhook.controller';
import { StripeWebhookService } from './webhooks/stripe/stripe-webhook.service';
import { StripeWebhookProcessor } from './webhooks/stripe/stripe-webhook.processor';
import { SettlementController } from './settlement/settlement.controller';
import { SettlementService } from './settlement/settlement.service';
import { DisputeService } from './dispute/dispute.service';
import { PaymentProviderResolver } from './provider/payment-provider.resolver';
import { RazorpayOrderService } from './razorpay/razorpay-order.service';
import { RazorpayPaymentController } from './razorpay/razorpay-payment.controller';
import { RazorpayWebhookService } from './razorpay/razorpay-webhook.service';
import { RazorpayWebhookProcessor } from './razorpay/razorpay-webhook.processor';
import { RazorpayWebhookController } from './razorpay/razorpay-webhook.controller';
import { RazorpayConnectService } from './razorpay/razorpay-connect.service';
import { RazorpayConnectController } from './razorpay/razorpay-connect.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { BookingReferenceModule } from '../bookings/booking-reference.module';
import { CommerceModule } from '../commerce/commerce.module';

@Module({
  imports: [
    InventoryModule,
    PaymentConfigModule,
    OpsModule,
    BookingReferenceModule,
    CommerceModule,
  ],
  controllers: [
    PaymentsController,
    PaymentAdminController,
    MerchantOnboardingController,
    PromotionController,
    FinanceReconciliationController,
    PaymentOutageController,
    OrganizerConnectController,
    StripeWebhookController,
    SettlementController,
    RazorpayPaymentController,
    RazorpayWebhookController,
    RazorpayConnectController,
  ],
  providers: [
    PaymentsService,
    // Mock stays registered (default provider + PaymentsService's dev mock-pay path).
    MockPaymentProvider,
    // Active provider, keyed on PAYMENT_PROVIDER_NAME (default 'mock'). Only the
    // selected provider is constructed, so Stripe/Razorpay keys are never required
    // unless that provider is chosen.
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService, MockPaymentProvider],
      useFactory: selectPaymentProvider,
    },
    // Orchestration: routes + fails over across constructed provider adapters.
    PaymentProviderRegistry,
    PaymentOrchestrator,
    // Production binding: builds provider instances from config + secret manager.
    PaymentProviderFactory,
    // Merchant onboarding workflow.
    MerchantOnboardingService,
    // Environment promotion (validate → approve → apply).
    PromotionService,
    // Sandbox certification (10-step evidence run).
    SandboxCertificationService,
    // Production safety controls: payment-live readiness checklist.
    PaymentLiveReadinessService,
    // Finance reconciliation + discrepancy queue.
    FinanceReconciliationService,
    // Provider outage operations (suspensions + failover controls).
    PaymentOutageService,
    // Final launch gate (matrices + GO/NO-GO aggregation).
    LaunchGateService,
    // Admin console backend for runtime payment configuration.
    PaymentAdminService,
    // Multi-provider webhook routing + reconciliation/settlement.
    WebhookRouter,
    PaymentReconciliationService,
    // Organizer Stripe Connect onboarding (marketplace, US).
    OrganizerConnectService,
    // Durable, idempotent Stripe webhook pipeline (ingest + async processor).
    StripeWebhookService,
    StripeWebhookProcessor,
    // Marketplace settlement lifecycle + transfers.
    SettlementService,
    // Dispute (chargeback) synchronisation.
    DisputeService,
    // Multi-provider resolver (US→Stripe, IN→Razorpay; lazy construct + register).
    PaymentProviderResolver,
    // India (Razorpay) order/verify flow + durable webhook pipeline.
    RazorpayOrderService,
    RazorpayWebhookService,
    RazorpayWebhookProcessor,
    // Organizer India (Razorpay Route) payout account onboarding.
    RazorpayConnectService,
  ],
  exports: [
    PaymentsService,
    PaymentProviderFactory,
    PaymentProviderRegistry,
    FinanceReconciliationService,
    OrganizerConnectService,
    // Exported so the worker's sweep job can drive processPending().
    StripeWebhookProcessor,
    // Exported so the worker can promote completed-event settlements to ELIGIBLE.
    SettlementService,
    // Exported so the worker's sweep also drains Razorpay webhooks.
    RazorpayWebhookProcessor,
  ],
})
export class PaymentsModule {}
