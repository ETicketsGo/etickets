import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntitlementService } from './entitlements/entitlement.service';
import { EntitlementGuard } from './entitlements/requires-entitlement';
import { SubscriptionService } from './subscription.service';
import { BillingEventService } from './billing-event.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingCatalogService } from './billing-catalog.service';
import { BillingOffersService } from './billing-offers.service';
import { BillingReadService } from './billing-read.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingProviderEventService } from './billing-provider-events.service';
import { BillingSweepService } from './billing-sweep.service';
import { CreditPackPricesService } from './credit-pack-prices.service';
import { BillingTaxService } from './billing-tax.service';
import { OrganizerBillingController } from './billing.controller';
import { AdminBillingController } from './billing-admin.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import {
  BILLING_PROVIDER,
  DisabledBillingProvider,
  MockBillingProvider,
  type BillingProvider,
} from './provider/billing-provider';

/**
 * Organizer billing and entitlements.
 *
 * Global so any feature module can put `@RequiresEntitlement(key)` on a route or ask
 * `EntitlementService` without importing this module. Depends on the global Prisma, Audit,
 * Tenancy, Secrets, Notifications and DomainEvents modules only. Writes only its own tables
 * (and the usage ledger for credits); it shares no code path with ticket payments, payouts or
 * settlement - only the secret manager and the key-safety rules.
 *
 * Providers: BILLING_PROVIDER=disabled (default) refuses everything; =mock is the test double
 * (LOCAL, DEV, QA); =providers routes US accounts to Stripe Billing and IN accounts to Razorpay
 * Subscriptions, built lazily by BillingProviderRegistry on test keys only.
 */
@Global()
@Module({
  controllers: [OrganizerBillingController, AdminBillingController, BillingWebhookController],
  providers: [
    {
      provide: BILLING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): BillingProvider =>
        config.get<string>('BILLING_PROVIDER') === 'mock'
          ? new MockBillingProvider()
          : new DisabledBillingProvider(),
    },
    BillingProviderRegistry,
    EntitlementService,
    EntitlementGuard,
    SubscriptionService,
    BillingEventService,
    BillingInvoiceService,
    BillingCatalogService,
    BillingOffersService,
    BillingReadService,
    BillingCheckoutService,
    BillingProviderEventService,
    BillingSweepService,
    CreditPackPricesService,
    BillingTaxService,
  ],
  exports: [
    EntitlementService,
    EntitlementGuard,
    SubscriptionService,
    BillingSweepService,
    BILLING_PROVIDER,
  ],
})
export class BillingModule {}
