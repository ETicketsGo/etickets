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
import { OrganizerBillingController } from './billing.controller';
import { AdminBillingController } from './billing-admin.controller';
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
 * Tenancy and DomainEvents modules only. Writes only its own tables.
 *
 * The provider is the disabled one unless the boot check allowed BILLING_PROVIDER=mock
 * (LOCAL, DEV, QA). No real provider is wired in this change.
 */
@Global()
@Module({
  controllers: [OrganizerBillingController, AdminBillingController],
  providers: [
    {
      provide: BILLING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): BillingProvider =>
        config.get<string>('BILLING_PROVIDER') === 'mock'
          ? new MockBillingProvider()
          : new DisabledBillingProvider(),
    },
    EntitlementService,
    EntitlementGuard,
    SubscriptionService,
    BillingEventService,
    BillingInvoiceService,
    BillingCatalogService,
    BillingOffersService,
    BillingReadService,
  ],
  exports: [EntitlementService, EntitlementGuard, SubscriptionService, BILLING_PROVIDER],
})
export class BillingModule {}
