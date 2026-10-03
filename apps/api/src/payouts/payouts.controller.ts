import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { PayoutsService } from './payouts.service';
import { PayoutSettingsService } from './payout-settings.service';
import { PayoutAccountsService } from './payout-accounts.service';
import { UnifiedFinanceService } from '../finance/unified-finance.service';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * What an admin may write. `null` clears an override back to inherited; an absent field
 * leaves it exactly as it was, so a screen that edits one term cannot blank the other.
 */
const SETTINGS_BODY = z.object({
  holdDays: z.number().int().min(0).max(365).nullable().optional(),
  minPayoutMinor: z.record(z.number().int().min(0)).nullable().optional(),
  autoGenerate: z.boolean().nullable().optional(),
  runFrequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).nullable().optional(),
  runAnchorDay: z.number().int().min(1).max(28).nullable().optional(),
});

/** Bank details an organizer enters. The number never comes back out of the API. */
const ACCOUNT_BODY = z.object({
  organizationId: z.string().cuid(),
  currency: z.string().trim().length(3),
  holderName: z.string().trim().min(2).max(140),
  bankName: z.string().trim().min(2).max(140),
  /** IFSC, routing number or SWIFT/BIC. Not a secret, and not validated per country here. */
  bankCode: z.string().trim().min(4).max(34),
  accountNumber: z.string().trim().min(6).max(34),
});
type SettingsBody = z.infer<typeof SETTINGS_BODY>;

@ApiTags('payouts')
@ApiBearerAuth()
@Controller('payouts')
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly accounts_: PayoutAccountsService,
    private readonly finance: UnifiedFinanceService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List payouts for an organization.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.payouts.listForOrg(user, q.organizationId);
  }

  /**
   * What this organization is owed, has been paid, and is waiting on.
   *
   * A GET, and observational by contract: it creates no payout, claims no revenue, changes no
   * status and contacts no provider. It reuses the payout ledger's own eligibility rules and the
   * one settlement calculation, so a finance screen and the payout it would raise cannot
   * disagree. Figures are per currency and never combined.
   */

  /**
   * Every financial record this organization has, by currency - across BOTH settlement paths.
   *
   * ── WHY THIS SITS BESIDE /payouts/summary RATHER THAN REPLACING IT ─────────────────
   * They answer different questions and both are wanted. `summary` is forward-looking: what a
   * payout raised right now would come to, computed from current booking state, which is what an
   * organizer asking "when do I get paid" needs. This is historical: which financial records
   * exist, what they say, and which path owns them. Folding the second into the first would make
   * a live projection carry immutable evidence, and neither question would be answered cleanly.
   *
   * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────
   * No writes, no provider calls, no reconciliation. Opening a finance screen must not move money
   * or ask a payment provider anything. Authorization happens inside the service BEFORE any
   * financial row is read - see `UnifiedFinanceService` - so a refused request never loads another
   * tenant's evidence at all.
   *
   * `eventId` narrows to one event's authoritative participation. A period payout with
   * `eventId: null` is still returned when its allocations prove the event took part; a legacy
   * period payout whose membership was never recorded is not, and the response says why rather
   * than implying the event was unpaid.
   */
  @Get('finance')
  @ApiOperation({
    summary: "An organization's financial records across both settlement paths, by currency.",
  })
  finance_(
    @CurrentUser() user: RequestUser,
    @Query(
      new ZodValidationPipe(
        z.object({ organizationId: z.string().cuid(), eventId: z.string().cuid().optional() }),
      ),
    )
    q: { organizationId: string; eventId?: string },
  ) {
    return this.finance.forOrganization(user, q.organizationId, q.eventId);
  }

  @Get('summary')
  @ApiOperation({ summary: "An organization's settlement position, per currency (read only)." })
  summary(
    @CurrentUser() user: RequestUser,
    @Query(
      new ZodValidationPipe(
        z.object({ organizationId: z.string().cuid(), eventId: z.string().cuid().optional() }),
      ),
    )
    q: { organizationId: string; eventId?: string },
  ) {
    return this.payouts.summary(user, q.organizationId, q.eventId);
  }

  /**
   * Where this organization's payout setup stands, as one state rather than five booleans.
   *
   * The server decides what the facts mean, so every consumer - this console, mobile, admin -
   * reads the same answer. `organizerActionRequired` is false whenever the wait is ETicketsGo's,
   * and no action is ever offered alongside it.
   */
  @Get('account-state')
  @ApiOperation({ summary: "An organization's payout account state (read only)." })
  accountState(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.payouts.accountState(user, q.organizationId);
  }

  /**
   * The organizer's own bank details.
   *
   * Entered by the owner, shown back masked. The full number is never returned here - see
   * the admin reveal, which is audited.
   */
  @Get('accounts')
  @ApiOperation({ summary: 'Payout bank accounts for an organization (masked).' })
  accounts(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.accounts_.listForOrg(user, q.organizationId);
  }

  @Post('accounts')
  @Roles(Role.ORGANIZER_OWNER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Add or replace the payout bank account for one currency.' })
  saveAccount(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(ACCOUNT_BODY)) body: z.infer<typeof ACCOUNT_BODY>,
  ) {
    const { organizationId, ...rest } = body;
    return this.accounts_.save(user, organizationId, rest);
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
  constructor(
    private readonly payouts: PayoutsService,
    private readonly accounts_: PayoutAccountsService,
  ) {}

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

  @Get('accounts')
  @ApiOperation({ summary: 'Every payout bank account, masked (admin).' })
  accounts() {
    return this.accounts_.adminList();
  }

  /**
   * The full account number, once, for the person about to make the transfer.
   *
   * A reveal is somebody taking a bank account number out of the system, so it is recorded
   * with who asked and why - the same shape as the SNS confirmation reveal.
   */
  @Post('accounts/:id/reveal')
  @ApiOperation({ summary: 'Reveal one account number, recorded in the audit log (admin).' })
  revealAccount(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ reason: z.string().trim().min(1).max(200) })))
    body: { reason: string },
  ) {
    return this.accounts_.reveal(admin, id, body.reason);
  }

  @Post('accounts/:id/verified')
  @ApiOperation({ summary: 'Record that the account has been checked (admin).' })
  verifyAccount(@CurrentUser() admin: RequestUser, @Param('id') id: string) {
    return this.accounts_.markVerified(admin, id);
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
