import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, RequiresRecentMfa, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { FeeSchedulesService } from './fee-schedules.service';

/*
  Draft bands are checked for SHAPE here (whole minor units, known fee types, sane sizes) and
  for MEANING by the service (`validateSchedule`), which is allowed to find problems: a draft
  may be broken while it is edited. Only a submission (and the approval) insists it is whole.
*/
const minor = z.number().int().min(0).max(1_000_000_000);
const bandSchema = z.object({
  key: z.string().trim().min(1).max(64),
  sourceId: z.string().trim().min(1).max(64).nullable(),
  minMinor: minor,
  maxMinor: minor.nullable(),
  feeType: z.enum(['FLAT', 'PERCENT', 'COMBINED', 'FIXED_PER_TICKET']),
  feeMinor: minor,
  feePercentBps: z.number().int().min(0).max(10_000).nullable(),
  minFeeMinor: minor.nullable(),
  maxFeeMinor: minor.nullable(),
  country: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(80),
  active: z.boolean(),
});
const saveSchema = z.object({ bands: z.array(bandSchema).max(200) });
type SaveBody = z.infer<typeof saveSchema>;
const currencySchema = z.object({ currency: z.string().trim().toUpperCase().length(3) });
type CurrencyBody = z.infer<typeof currencySchema>;
const noteSchema = z.object({ note: z.string().trim().max(1000).optional() });
type NoteBody = z.infer<typeof noteSchema>;
const rejectSchema = z.object({ note: z.string().trim().min(5).max(1000) });
type RejectBody = z.infer<typeof rejectSchema>;
const rollbackSchema = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().min(20).max(1000),
});
type RollbackBody = z.infer<typeof rollbackSchema>;

/**
 * Booking-fee schedules: drafted and submitted by one person, approved by another.
 *
 * Reads need PLATFORM_CONFIG_READ. Drafting and submitting need PLATFORM_CONFIG: neither
 * changes a price, so neither asks for a fresh second-factor check. Approving changes what
 * every later buyer pays, so it needs FEE_SCHEDULE_APPROVE AND a fresh check - and the service
 * refuses anybody who worked on the draft, whatever they hold. Rejecting needs the same duty
 * (no fresh check: it changes no price). An emergency rollback needs PLATFORM_CONFIG,
 * FEE_SCHEDULE_APPROVE and a fresh check.
 *
 * Each handler names its own capability; the class default is the write, so a handler that
 * forgot its decorator fails closed.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
@Controller('admin/fee-schedules')
export class FeeSchedulesController {
  constructor(private readonly schedules: FeeSchedulesService) {}

  @Get(':currency')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({
    summary: 'Live fee schedule of a currency, its versions and open/pending draft.',
  })
  overview(@Param('currency') currency: string) {
    return this.schedules.overview(currency.trim().toUpperCase());
  }

  @Get('drafts/:id')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({ summary: 'A draft fee schedule with its check, preview and approval history.' })
  draft(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.schedules.draft(id, user.id);
  }

  @Get('drafts/:id/impact')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({ summary: 'Estimated booking-fee change for recent real orders (read-only).' })
  impact(@Param('id') id: string, @Query('days') days?: string) {
    return this.schedules.impact(id, days ? Number(days) : 30);
  }

  @Post('drafts')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Start a draft from the live fee schedule (or open the current one).' })
  createDraft(
    @CurrentUser() user: { id: string },
    @Body(new ZodValidationPipe(currencySchema)) body: CurrencyBody,
  ) {
    return this.schedules.createDraft(user.id, body.currency);
  }

  @Put('drafts/:id')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Save the bands of a draft fee schedule. Changes no price.' })
  saveDraft(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(saveSchema)) body: SaveBody,
  ) {
    return this.schedules.saveDraft(user.id, id, body.bands);
  }

  @Delete('drafts/:id')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Discard a draft fee schedule.' })
  discardDraft(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.schedules.discardDraft(user.id, id);
  }

  @Post('drafts/:id/submit')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Submit a draft for approval by another administrator.' })
  submit(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: NoteBody,
  ) {
    return this.schedules.submit(user.id, id, body.note);
  }

  @Post('drafts/:id/withdraw')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Take a submitted draft back to edit it (its makers only).' })
  withdraw(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.schedules.withdraw(user.id, id);
  }

  @Post('drafts/:id/approve')
  @RequiresAdmin(AdminPermission.FEE_SCHEDULE_APPROVE)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Approve a submitted draft, which publishes it (not its maker).' })
  approve(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: NoteBody,
  ) {
    return this.schedules.approve(user.id, id, body.note);
  }

  @Post('drafts/:id/reject')
  @RequiresAdmin(AdminPermission.FEE_SCHEDULE_APPROVE)
  @ApiOperation({ summary: 'Send a submitted draft back to its maker with a reason.' })
  reject(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: RejectBody,
  ) {
    return this.schedules.reject(user.id, id, body.note);
  }

  /** Retired: answers 409 FEE_SCHEDULE_APPROVAL_REQUIRED. See the service. */
  @Post('drafts/:id/publish')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Retired: a schedule is published by approval. Always refused.' })
  publishFeeSchedule(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.schedules.publish(user.id, id);
  }

  @Post(':currency/emergency-rollback')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG, AdminPermission.FEE_SCHEDULE_APPROVE)
  @RequiresRecentMfa()
  @ApiOperation({
    summary: 'Restore an earlier published version now, alone, with a reason (break glass).',
  })
  emergencyRollback(
    @CurrentUser() user: { id: string },
    @Param('currency') currency: string,
    @Body(new ZodValidationPipe(rollbackSchema)) body: RollbackBody,
  ) {
    return this.schedules.emergencyRollback(
      user.id,
      currency.trim().toUpperCase(),
      body.version,
      body.reason,
    );
  }
}
