import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { PayoutsService } from './payouts.service';
import { PayoutSettingsService } from './payout-settings.service';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * What an admin may write. `null` clears an override back to inherited; an absent field
 * leaves it exactly as it was, so a screen that edits one term cannot blank the other.
 */
const SETTINGS_BODY = z.object({
  holdDays: z.number().int().min(0).max(365).nullable().optional(),
  minPayoutMinor: z.record(z.number().int().min(0)).nullable().optional(),
});
type SettingsBody = z.infer<typeof SETTINGS_BODY>;

@ApiTags('payouts')
@ApiBearerAuth()
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @ApiOperation({ summary: 'List payouts for an organization.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.payouts.listForOrg(user, q.organizationId);
  }

  @Post('generate')
  @Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Generate a settlement payout for an organization/event.' })
  generate(
    @CurrentUser() user: RequestUser,
    @Body(
      new ZodValidationPipe(
        z.object({ organizationId: z.string().cuid(), eventId: z.string().cuid().optional() }),
      ),
    )
    body: { organizationId: string; eventId?: string },
  ) {
    return this.payouts.generate(user, body.organizationId, body.eventId);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PAYOUT_MANAGE)
@Controller('admin/payouts')
export class AdminPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @ApiOperation({ summary: 'List all payouts (admin).' })
  list() {
    return this.payouts.adminList();
  }

  @Post(':id/pay')
  @ApiOperation({ summary: 'Mark a payout as paid, with the bank reference (admin).' })
  pay(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(
      new ZodValidationPipe(
        z.object({
          // The bank's own reference (UTR, wire ref). Optional because a correction posted by
          // hand may have none, and refusing would leave money paid and the ledger disagreeing.
          reference: z.string().trim().max(120).optional(),
          note: z.string().trim().max(500).optional(),
        }),
      ),
    )
    body: { reference?: string; note?: string } = {},
  ) {
    return this.payouts.markPaid(admin, id, body);
  }

  @Post(':id/fail')
  @ApiOperation({ summary: 'Record that a payout did not reach the organizer (admin).' })
  fail(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ reason: z.string().trim().min(1).max(500) })))
    body: { reason: string },
  ) {
    return this.payouts.markFailed(admin, id, body.reason);
  }
}

/**
 * The terms settlements run under: the platform default, and per-organization overrides.
 *
 * Admin-only and audited. These are commercial terms - how long money is held, how small a
 * payout is worth banking - and they used to be environment variables, which meant one number
 * for every organizer and a deploy to change it.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PAYOUT_MANAGE)
@Controller('admin/payout-settings')
export class AdminPayoutSettingsController {
  constructor(private readonly settings: PayoutSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'The platform terms and every organization override (admin).' })
  list() {
    return this.settings.list();
  }

  @Get('effective/:organizationId')
  @ApiOperation({ summary: 'The terms one organization settles on, and where each came from.' })
  effective(@Param('organizationId') organizationId: string) {
    return this.settings.effectiveFor(organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Set the platform terms (admin).' })
  updatePlatform(
    @CurrentUser() admin: RequestUser,
    @Body(new ZodValidationPipe(SETTINGS_BODY)) body: SettingsBody,
  ) {
    return this.settings.update(admin, null, body);
  }

  @Post(':organizationId')
  @ApiOperation({ summary: "Set one organization's terms (admin). Null inherits." })
  updateOrganization(
    @CurrentUser() admin: RequestUser,
    @Param('organizationId') organizationId: string,
    @Body(new ZodValidationPipe(SETTINGS_BODY)) body: SettingsBody,
  ) {
    return this.settings.update(admin, organizationId, body);
  }
}
