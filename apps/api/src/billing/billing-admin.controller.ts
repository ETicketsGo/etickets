import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role, type EntitlementValue } from '@eticketsgo/shared-types';
import {
  CurrentUser,
  RequiresAdmin,
  RequiresRecentMfa,
  Roles,
  type RequestUser,
} from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BillingCatalogService } from './billing-catalog.service';
import { BillingReadService } from './billing-read.service';
import { BillingOffersService } from './billing-offers.service';
import { SubscriptionService } from './subscription.service';
import { CreditPackPricesService } from './credit-pack-prices.service';
import { BillingPriceReconcileService } from './billing-price-reconcile.service';
import {
  createPriceSchema,
  endGrantSchema,
  grantComplimentarySchema,
  grantCreditsSchema,
  grantOverrideSchema,
  grantTrialSchema,
  loadCatalogSchema,
  metricsQuerySchema,
  publishCreditPackSchema,
  recordDiscountSchema,
  revokeOverrideSchema,
  setCreditPackPriceSchema,
  setPlanEntitlementsSchema,
  subscriptionSearchSchema,
  updatePlanSchema,
  updatePriceSchema,
} from './billing.schemas';

/*
  Not called `Body`: decorator metadata emits a parameter's TYPE name as a runtime value (see
  crm.controller.ts for the defect that taught this).
*/
type Payload<S extends z.ZodTypeAny> = z.output<S>;
const pipe = <S extends z.ZodTypeAny>(schema: S) =>
  new ZodValidationPipe<z.output<S>>(schema as unknown as z.ZodType<z.output<S>>);

/*
  ── WHO CAN CALL WHAT ────────────────────────────────────────────────────────────────
  Every route: a back-office account holding BILLING_READ (the class floor). Each write declares
  its own capability, never a read one, and a recent second factor:
    BILLING_MANAGE     plans, prices, plan entitlements, loading the provisional catalogue,
                       credit pack prices and publishing them;
    BILLING_ADJUST     trials, complimentary plans, ending them, credits, discounts;
    ENTITLEMENT_GRANT  single-entitlement overrides and their revocation.
  A method's own @RequiresAdmin replaces the class floor, so a write names only its write
  capability (admin-surface.spec.ts refuses a read capability on a write). The bundle that
  carries a write (BILLING_DESK) carries BILLING_READ too, so its holder can open the pages.
  Nothing here moves ticket money or opens bookings, payouts or bank data.
*/
@ApiTags('admin-billing')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.BILLING_READ)
@Controller('admin/billing')
export class AdminBillingController {
  constructor(
    private readonly catalog: BillingCatalogService,
    private readonly reads: BillingReadService,
    private readonly offers: BillingOffersService,
    private readonly subscriptions: SubscriptionService,
    private readonly packPrices: CreditPackPricesService,
    private readonly priceCheck: BillingPriceReconcileService,
  ) {}

  // ── Email credit packs ──────────────────────────────────────────────────────

  @Get('credit-packs')
  @ApiOperation({ summary: 'Credit packs with their price and publication per country.' })
  creditPacks() {
    return this.packPrices.list();
  }

  @Put('credit-packs/:packCode/prices/:country')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Set a credit pack price (before tax). Publication is unchanged.' })
  setCreditPackPrice(
    @CurrentUser() actor: RequestUser,
    @Param('packCode') packCode: string,
    @Param('country') country: string,
    @Body(pipe(setCreditPackPriceSchema)) body: Payload<typeof setCreditPackPriceSchema>,
  ) {
    return this.packPrices.setPrice(packCode, country.toUpperCase(), body, actor.id);
  }

  @Post('credit-packs/:packCode/prices/:country/publish')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Put a priced credit pack on sale in that country.' })
  publishCreditPack(
    @CurrentUser() actor: RequestUser,
    @Param('packCode') packCode: string,
    @Param('country') country: string,
    @Body(pipe(publishCreditPackSchema)) body: Payload<typeof publishCreditPackSchema>,
  ) {
    return this.packPrices.setPublished(
      packCode,
      country.toUpperCase(),
      true,
      actor.id,
      body.expectedVersion,
    );
  }

  @Post('credit-packs/:packCode/prices/:country/unpublish')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Take a credit pack off sale in that country.' })
  unpublishCreditPack(
    @CurrentUser() actor: RequestUser,
    @Param('packCode') packCode: string,
    @Param('country') country: string,
    @Body(pipe(publishCreditPackSchema)) body: Payload<typeof publishCreditPackSchema>,
  ) {
    return this.packPrices.setPublished(
      packCode,
      country.toUpperCase(),
      false,
      actor.id,
      body.expectedVersion,
    );
  }

  // ── Catalogue ───────────────────────────────────────────────────────────────

  @Get('plans')
  @ApiOperation({ summary: 'Plans with their prices and entitlements.' })
  plans() {
    return this.catalog.list();
  }

  @Get('prices/provider-check')
  @ApiOperation({
    summary:
      'Compare each plan price with its Stripe price. Read-only: reports differences and ' +
      'changes nothing (the catalogue is authoritative).',
  })
  providerCheck() {
    return this.priceCheck.run({ record: false });
  }

  @Post('catalog/load-provisional')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  @ApiOperation({
    summary: 'Load the provisional plans and prices. Idempotent; overwrites nothing.',
  })
  loadCatalog(
    @CurrentUser() actor: RequestUser,
    @Body(pipe(loadCatalogSchema)) _body: Payload<typeof loadCatalogSchema>,
  ) {
    return this.catalog.loadProvisional(actor.id);
  }

  @Patch('plans/:id')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  updatePlan(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(updatePlanSchema)) body: Payload<typeof updatePlanSchema>,
  ) {
    return this.catalog.updatePlan(id, body, actor.id);
  }

  @Put('plans/:id/entitlements')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  setPlanEntitlements(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(setPlanEntitlementsSchema)) body: Payload<typeof setPlanEntitlementsSchema>,
  ) {
    return this.catalog.setPlanEntitlements(id, body.entitlements as EntitlementValue[], actor.id);
  }

  @Post('prices')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  createPrice(
    @CurrentUser() actor: RequestUser,
    @Body(pipe(createPriceSchema)) body: Payload<typeof createPriceSchema>,
  ) {
    return this.catalog.createPrice(body, actor.id);
  }

  @Patch('prices/:id')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  updatePrice(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(updatePriceSchema)) body: Payload<typeof updatePriceSchema>,
  ) {
    return this.catalog.updatePrice(id, body, actor.id);
  }

  @Post('prices/:id/deactivate')
  @RequiresAdmin(AdminPermission.BILLING_MANAGE)
  @RequiresRecentMfa()
  deactivatePrice(@CurrentUser() actor: RequestUser, @Param('id') id: string) {
    return this.catalog.deactivatePrice(id, actor.id);
  }

  // ── Subscriptions and accounts ──────────────────────────────────────────────

  @Get('subscriptions')
  @ApiOperation({ summary: 'Search subscriptions by status, plan, country or organization.' })
  searchSubscriptions(
    @Query(pipe(subscriptionSearchSchema)) q: Payload<typeof subscriptionSearchSchema>,
  ) {
    return this.reads.searchSubscriptions(q);
  }

  @Get('accounts/:organizationId')
  @ApiOperation({ summary: 'One organization: subscription, invoices, ledger, overrides, usage.' })
  account(@Param('organizationId') organizationId: string) {
    return this.reads.accountDetail(organizationId);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Subscriptions, MRR and ARR per currency, revenue by plan, churn.' })
  metrics(@Query(pipe(metricsQuerySchema)) q: Payload<typeof metricsQuerySchema>) {
    return this.reads.metrics(q.days);
  }

  // ── Commercial offers ───────────────────────────────────────────────────────

  @Post('accounts/:organizationId/trial')
  @RequiresAdmin(AdminPermission.BILLING_ADJUST)
  @RequiresRecentMfa()
  grantTrial(
    @CurrentUser() actor: RequestUser,
    @Param('organizationId') organizationId: string,
    @Body(pipe(grantTrialSchema)) body: Payload<typeof grantTrialSchema>,
  ) {
    return this.subscriptions.grantTrial(organizationId, body, actor.id);
  }

  @Post('accounts/:organizationId/complimentary')
  @RequiresAdmin(AdminPermission.BILLING_ADJUST)
  @RequiresRecentMfa()
  grantComplimentary(
    @CurrentUser() actor: RequestUser,
    @Param('organizationId') organizationId: string,
    @Body(pipe(grantComplimentarySchema)) body: Payload<typeof grantComplimentarySchema>,
  ) {
    return this.subscriptions.grantComplimentary(
      organizationId,
      { planCode: body.planCode, endsAt: body.endsAt ?? null, reason: body.reason },
      actor.id,
    );
  }

  @Post('accounts/:organizationId/end-grant')
  @RequiresAdmin(AdminPermission.BILLING_ADJUST)
  @RequiresRecentMfa()
  endGrant(
    @CurrentUser() actor: RequestUser,
    @Param('organizationId') organizationId: string,
    @Body(pipe(endGrantSchema)) body: Payload<typeof endGrantSchema>,
  ) {
    return this.subscriptions.endGrant(organizationId, body.reason, actor.id);
  }

  @Post('accounts/:organizationId/credits')
  @RequiresAdmin(AdminPermission.BILLING_ADJUST)
  @RequiresRecentMfa()
  grantCredits(
    @CurrentUser() actor: RequestUser,
    @Param('organizationId') organizationId: string,
    @Body(pipe(grantCreditsSchema)) body: Payload<typeof grantCreditsSchema>,
  ) {
    return this.offers.grantCredits(organizationId, body, actor.id);
  }

  @Post('accounts/:organizationId/discounts')
  @RequiresAdmin(AdminPermission.BILLING_ADJUST)
  @RequiresRecentMfa()
  recordDiscount(
    @CurrentUser() actor: RequestUser,
    @Param('organizationId') organizationId: string,
    @Body(pipe(recordDiscountSchema)) body: Payload<typeof recordDiscountSchema>,
  ) {
    return this.offers.recordDiscount(organizationId, body, actor.id);
  }

  @Post('accounts/:organizationId/overrides')
  @RequiresAdmin(AdminPermission.ENTITLEMENT_GRANT)
  @RequiresRecentMfa()
  grantOverride(
    @CurrentUser() actor: RequestUser,
    @Param('organizationId') organizationId: string,
    @Body(pipe(grantOverrideSchema)) body: Payload<typeof grantOverrideSchema>,
  ) {
    return this.offers.grantOverride(organizationId, body, actor.id);
  }

  @Post('overrides/:id/revoke')
  @RequiresAdmin(AdminPermission.ENTITLEMENT_GRANT)
  @RequiresRecentMfa()
  revokeOverride(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(revokeOverrideSchema)) body: Payload<typeof revokeOverrideSchema>,
  ) {
    return this.offers.revokeOverride(id, body.reason, actor.id);
  }
}
