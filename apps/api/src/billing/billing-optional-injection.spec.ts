import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TransactionalEventPublisher } from '../common/domain-events';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { OpsAlertService } from '../ops/alerts/ops-alert.service';
import { EntitlementService } from './entitlements/entitlement.service';
import { SubscriptionService } from './subscription.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingTaxService } from './billing-tax.service';
import { BillingProviderEventService } from './billing-provider-events.service';
import { BillingSweepService } from './billing-sweep.service';
import { BillingPriceReconcileService } from './billing-price-reconcile.service';
import { BillingProviderRegistry } from './provider/billing-provider.registry';

/*
  The defect this pins (found on QA, 2026-10-31): `@Optional() x: Service | null = null` emits
  `Object` as the parameter's design type - TypeScript does not strip `| null` from decorator
  metadata - so Nest looked up a provider called Object, found none, and @Optional() quietly
  handed in nothing. Every dunning email was dropped (the owners fan-out was null) and the
  provider-event tax quote was always null. Unit tests passed the services in by hand, so
  only Nest's own resolution shows it.
*/
describe('billing services resolve their optional collaborators through Nest', () => {
  const stub = (token: unknown) => ({ provide: token as never, useValue: { stub: token } });

  it('the webhook processor, the sweep and the price check get the audience, tax and alerts', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        BillingProviderEventService,
        BillingSweepService,
        BillingPriceReconcileService,
        stub(PrismaService),
        stub(AuditService),
        stub(SubscriptionService),
        stub(EntitlementService),
        stub(TransactionalEventPublisher),
        stub(BillingInvoiceService),
        stub(BillingProviderRegistry),
        stub(ConfigService),
        stub(AdminAudienceService),
        stub(BillingTaxService),
        stub(OpsAlertService),
      ],
    }).compile();

    const events = moduleRef.get(BillingProviderEventService) as unknown as Record<string, unknown>;
    const sweep = moduleRef.get(BillingSweepService) as unknown as Record<string, unknown>;
    const check = moduleRef.get(BillingPriceReconcileService) as unknown as Record<string, unknown>;
    expect(events.audience).toEqual({ stub: AdminAudienceService });
    expect(events.tax).toEqual({ stub: BillingTaxService });
    expect(sweep.audience).toEqual({ stub: AdminAudienceService });
    expect(check.alerts).toEqual({ stub: OpsAlertService });
    await moduleRef.close();
  });
});
