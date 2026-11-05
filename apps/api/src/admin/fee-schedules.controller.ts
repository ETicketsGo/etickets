import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, RequiresRecentMfa, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { FeeSchedulesService } from './fee-schedules.service';

/*
  Draft bands are checked for SHAPE here (whole minor units, known fee types, sane sizes) and
  for MEANING by the service (`validateSchedule`), which is allowed to find problems: a draft
  may be broken while it is edited. Only a publish insists that it is whole.
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

/**
 * Booking-fee schedules edited as drafts and published whole.
 *
 * Reads need PLATFORM_CONFIG_READ. Drafting needs PLATFORM_CONFIG: a draft changes no price,
 * so it does not ask for a fresh second-factor check. Publishing changes what every later
 * buyer pays, so it needs PLATFORM_CONFIG AND a fresh check, like every other fee write.
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
  @ApiOperation({ summary: 'Live fee schedule of a currency, its version and open draft.' })
  overview(@Param('currency') currency: string) {
    return this.schedules.overview(currency.trim().toUpperCase());
  }

  @Get('drafts/:id')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({ summary: 'A draft fee schedule with its check and fee preview.' })
  draft(@Param('id') id: string) {
    return this.schedules.draft(id);
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

  @Post('drafts/:id/publish')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Publish a draft fee schedule in one transaction (admin).' })
  publishFeeSchedule(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.schedules.publish(user.id, id);
  }
}
