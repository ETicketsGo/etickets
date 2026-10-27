import { Body, Controller, Get, HttpStatus, Inject, Param, Post } from '@nestjs/common';
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
import { ensureBillingAccount } from './billing-account';
import { checkoutSchema } from './billing.schemas';
import {
  BILLING_NOT_ENABLED_MESSAGE,
  BILLING_PROVIDER,
  type BillingProvider,
} from './provider/billing-provider';

/** Plans and invoices name what the organization pays: owners and managers, as receipts. */
const BILLING_VIEWER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/*
  ── WHO CAN CALL WHAT ────────────────────────────────────────────────────────────────
  Organizer routes. Platform staff who are not members get nothing here (the tenant check
  refuses and audits them); staff read billing on /admin/billing with BILLING_READ instead.
  Checkout is the organization's own decision to pay, so it is @OrganizerOnly.
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
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  @Get(':id/entitlements')
  @ApiOperation({ summary: 'What this organization may use now: plan, overrides, deployment switches.' })
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
  @ApiOperation({ summary: 'Platform invoices to this organization (none until paid plans open).' })
  async invoices(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.access.assertMember(user, id, BILLING_VIEWER_ROLES);
    return this.reads.organizerInvoices(id);
  }

  @Post(':id/billing/checkout')
  @OrganizerOnly('billing.checkout')
  @ApiOperation({ summary: 'Start paying for a plan. Refused while paid plans are not open.' })
  async checkout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    await this.access.assertMember(user, id, [Role.ORGANIZER_OWNER]);
    if (!this.reads.billingEnabled()) {
      throw new AppException(
        ErrorCodes.BILLING_NOT_ENABLED,
        BILLING_NOT_ENABLED_MESSAGE,
        HttpStatus.CONFLICT,
      );
    }
    const price = await this.prisma.billingPrice.findUnique({ where: { id: body.priceId } });
    const account = await this.prisma.$transaction((tx) => ensureBillingAccount(tx, id));
    if (!price || !price.active || price.country !== account.country) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That price is not offered in your country.',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.provider.createCheckout({
      organizationId: id,
      accountId: account.id,
      priceId: price.id,
      country: price.country,
      currency: price.currency,
      amountMinor: price.amountMinor,
      interval: price.interval,
    });
  }
}
