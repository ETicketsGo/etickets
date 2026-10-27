import { Body, Controller, Get, Header, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException, ErrorCodes } from '../common/errors';
import { OrgAccessService } from '../tenancy/org-access.service';
import { OrganizerOnly } from '../tenancy/organizer-only.guard';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementService } from './entitlements/entitlement.service';
import { BillingReadService } from './billing-read.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { renderBillingInvoiceHtml } from './billing-invoice-html';
import { billingCancelSchema, checkoutSchema, creditPackCheckoutSchema } from './billing.schemas';

/** Plans and invoices name what the organization pays: owners and managers, as receipts. */
const BILLING_VIEWER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/*
  ── WHO CAN CALL WHAT ────────────────────────────────────────────────────────────────
  Organizer routes. Platform staff who are not members get nothing here (the tenant check
  refuses and audits them); staff read billing on /admin/billing with BILLING_READ instead.
  Starting to pay, the portal and cancelling are the organization's own decisions, so they are
  @OrganizerOnly and the OWNER's alone. Every route checks membership of THIS organization
  first, so one organization's owner can never start a checkout or open a portal for another.
*/
@ApiTags('billing')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizerBillingController {
  constructor(
    private readonly access: OrgAccessService,
    private readonly entitlements: EntitlementService,
    private readonly reads: BillingReadService,
    private readonly prisma: PrismaService,
    private readonly checkouts: BillingCheckoutService,
  ) {}

  @Get(':id/entitlements')
  @ApiOperation({
    summary: 'What this organization may use now: plan, overrides, deployment switches.',
  })
  async entitlementsFor(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    // Any member: check-in staff are told what the console can do too.
    await this.access.assertMember(user, id);
    return this.entitlements.resolve(id);
  }

  @Get(':id/billing')
  @ApiOperation({ summary: 'Current plan, usage, the plans and their prices in this country.' })
  async billing(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.access.assertMember(user, id, BILLING_VIEWER_ROLES);
    return this.reads.organizerBilling(id);
  }

  @Get(':id/billing/invoices')
  @ApiOperation({ summary: 'Platform invoices to this organization.' })
  async invoices(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.access.assertMember(user, id, BILLING_VIEWER_ROLES);
    return this.reads.organizerInvoices(id);
  }

  @Get(':id/billing/invoices/:invoiceId/html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  // A financial document: never kept by a shared proxy.
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'One platform invoice as printable HTML.' })
  async invoiceHtml(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('invoiceId') invoiceId: string,
  ) {
    await this.access.assertMember(user, id, BILLING_VIEWER_ROLES);
    const invoice = await this.prisma.organizerInvoice.findUnique({
      where: { id: invoiceId },
      include: { account: true },
    });
    // Another organization's invoice is "not found", never "forbidden": ids are not a way in.
    if (!invoice || invoice.account.organizationId !== id || !invoice.number) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Invoice not found.', HttpStatus.NOT_FOUND);
    }
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id },
      select: { name: true, legalName: true },
    });
    const doc = (invoice.documentJson ?? {}) as {
      taxLines?: { label: string; rateBasisPoints: number; amountMinor: number }[];
      placeOfSupply?: { region?: string | null; country?: string } | null;
    };
    return renderBillingInvoiceHtml({
      taxLines: Array.isArray(doc.taxLines) ? doc.taxLines : [],
      placeOfSupply: doc.placeOfSupply?.region
        ? `${doc.placeOfSupply.region}, ${doc.placeOfSupply.country ?? invoice.account.country}`
        : null,
      number: invoice.number,
      status: invoice.status,
      issuedAt: invoice.issuedAt ?? invoice.createdAt,
      currency: invoice.currency,
      lines: invoice.lines as never,
      subtotalMinor: invoice.subtotalMinor,
      taxMinor: invoice.taxMinor,
      totalMinor: invoice.totalMinor,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      sellerName: 'ETicketsGo',
      billedTo: {
        name: org.legalName || org.name,
        country: invoice.account.country,
        taxId: invoice.account.taxId,
        email: invoice.account.billingEmail,
      },
    });
  }

  @Post(':id/billing/checkout')
  @OrganizerOnly('billing.checkout')
  @ApiOperation({ summary: 'Start paying for a plan: a hosted provider page. Owners only.' })
  async checkout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    await this.access.assertMember(user, id, [Role.ORGANIZER_OWNER]);
    return this.checkouts.startPlanCheckout(id, body.priceId);
  }

  @Post(':id/billing/credit-packs/checkout')
  @OrganizerOnly('billing.checkout')
  @ApiOperation({ summary: 'Buy a credit pack: a hosted one-time provider page. Owners only.' })
  async creditPackCheckout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(creditPackCheckoutSchema))
    body: z.infer<typeof creditPackCheckoutSchema>,
  ) {
    await this.access.assertMember(user, id, [Role.ORGANIZER_OWNER]);
    return this.checkouts.startCreditPackCheckout(id, body.packCode);
  }

  @Post(':id/billing/portal')
  @OrganizerOnly('billing.portal')
  @ApiOperation({ summary: 'Stripe Billing Portal: payment method and cancellation. Owners only.' })
  async portal(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.access.assertMember(user, id, [Role.ORGANIZER_OWNER]);
    return this.checkouts.portal(id);
  }

  @Post(':id/billing/cancel')
  @OrganizerOnly('billing.cancel')
  @ApiOperation({ summary: 'Cancel the paid plan at the end of its period. Owners only.' })
  async cancel(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(billingCancelSchema)) body: z.infer<typeof billingCancelSchema>,
  ) {
    await this.access.assertMember(user, id, [Role.ORGANIZER_OWNER]);
    const sub = await this.checkouts.cancel(id, user.id, body.reason ?? null);
    return {
      status: sub.status,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
  }
}
