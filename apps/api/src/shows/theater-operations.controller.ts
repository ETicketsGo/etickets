import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  blockSeatsSchema,
  cloneSeatLayoutSchema,
  publishSeatLayoutSchema,
  releaseSeatsSchema,
  updateSeatLayoutSchema,
  applyVenueTemplateSchema,
  type BlockSeatsInput,
  type CloneSeatLayoutInput,
  type PublishSeatLayoutInput,
  type ReleaseSeatsInput,
  type UpdateSeatLayoutInput,
  type ApplyVenueTemplateInput,
} from '@eticketsgo/validation';
import { SeatLayoutsService } from './seat-layouts.service';
import { SeatOverridesService } from './seat-overrides.service';
import { LiveOperationsService } from './live-operations.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * Theater operations: layout versions, seat overrides, live occupancy and reports.
 *
 * A separate controller from `ShowsController`, which is already large and is about
 * scheduling. These are the things a duty manager does to a room and to tonight's show,
 * which is a different job from planning next week.
 *
 * Every route is organizer-authenticated and tenancy-checked inside the services, via the
 * owning cinema's organization — never from anything the caller supplies.
 */
@ApiTags('theater-operations')
@ApiBearerAuth()
@Controller()
export class TheaterOperationsController {
  constructor(
    private readonly layouts: SeatLayoutsService,
    private readonly overrides: SeatOverridesService,
    private readonly live: LiveOperationsService,
  ) {}

  // ── Layout versions ─────────────────────────────────────────────────────────────

  @Get('screens/:screenId/seat-layouts')
  @ApiOperation({ summary: 'List every seat layout version for a screen.' })
  listLayouts(@CurrentUser() user: RequestUser, @Param('screenId') screenId: string) {
    return this.layouts.listVersions(user, screenId);
  }

  @Post('seat-layouts/:layoutId/clone')
  @ApiOperation({ summary: 'Clone a layout version into a new editable draft.' })
  cloneLayout(
    @CurrentUser() user: RequestUser,
    @Param('layoutId') layoutId: string,
    @Body(new ZodValidationPipe(cloneSeatLayoutSchema)) body: CloneSeatLayoutInput,
  ) {
    return this.layouts.clone(user, layoutId, body);
  }

  @Post('seat-layouts/:layoutId/draft')
  @ApiOperation({ summary: 'Replace a draft layout’s sections, rows and seats.' })
  updateDraft(
    @CurrentUser() user: RequestUser,
    @Param('layoutId') layoutId: string,
    @Body(new ZodValidationPipe(updateSeatLayoutSchema)) body: UpdateSeatLayoutInput,
  ) {
    return this.layouts.updateDraft(user, layoutId, body);
  }

  @Post('seat-layouts/:layoutId/from-template')
  @ApiOperation({ summary: 'Fill a draft layout from a venue template (arena, theatre, …).' })
  applyTemplate(
    @CurrentUser() user: RequestUser,
    @Param('layoutId') layoutId: string,
    @Body(new ZodValidationPipe(applyVenueTemplateSchema)) body: ApplyVenueTemplateInput,
  ) {
    return this.layouts.applyTemplate(user, layoutId, body);
  }

  @Post('seat-layouts/:layoutId/publish')
  @ApiOperation({ summary: 'Publish a draft, optionally effective from a future date.' })
  publishLayout(
    @CurrentUser() user: RequestUser,
    @Param('layoutId') layoutId: string,
    @Body(new ZodValidationPipe(publishSeatLayoutSchema)) body: PublishSeatLayoutInput,
  ) {
    return this.layouts.publish(user, layoutId, body);
  }

  @Post('seat-layouts/:layoutId/archive')
  @ApiOperation({ summary: 'Retire a superseded layout version.' })
  archiveLayout(@CurrentUser() user: RequestUser, @Param('layoutId') layoutId: string) {
    return this.layouts.archive(user, layoutId);
  }

  @Delete('seat-layouts/:layoutId')
  @ApiOperation({ summary: 'Discard a draft that was never published.' })
  deleteDraft(@CurrentUser() user: RequestUser, @Param('layoutId') layoutId: string) {
    return this.layouts.deleteDraft(user, layoutId);
  }

  @Get('seat-layouts/compare')
  @ApiOperation({ summary: 'Diff two layout versions of the same screen.' })
  compareLayouts(
    @CurrentUser() user: RequestUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.layouts.compare(user, from, to);
  }

  // ── Seat overrides ──────────────────────────────────────────────────────────────

  @Post('shows/:sessionId/seats/block')
  @ApiOperation({ summary: 'Block seats on one show (maintenance, house, VIP, emergency…).' })
  blockSeats(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(blockSeatsSchema)) body: BlockSeatsInput,
  ) {
    return this.overrides.blockSeats(user, sessionId, body);
  }

  @Post('shows/:sessionId/seats/release')
  @ApiOperation({ summary: 'Put blocked seats back on sale.' })
  releaseSeats(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(releaseSeatsSchema)) body: ReleaseSeatsInput,
  ) {
    return this.overrides.releaseSeats(user, sessionId, body);
  }

  @Get('shows/:sessionId/seats/:seatId/companions')
  @ApiOperation({ summary: 'Companion seats worth holding beside a wheelchair space.' })
  companions(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
    @Param('seatId') seatId: string,
  ) {
    return this.overrides.companionSuggestions(user, sessionId, seatId);
  }

  // ── Live operations ─────────────────────────────────────────────────────────────

  @Get('shows/:sessionId/occupancy')
  @ApiOperation({ summary: 'Live seat counts, occupancy and revenue for one show.' })
  occupancy(@CurrentUser() user: RequestUser, @Param('sessionId') sessionId: string) {
    return this.live.occupancy(user, sessionId);
  }

  @Get('shows/:sessionId/live-seat-map')
  @ApiOperation({ summary: 'Every seat of a show with its live state and any override.' })
  liveSeatMap(@CurrentUser() user: RequestUser, @Param('sessionId') sessionId: string) {
    return this.live.liveSeatMap(user, sessionId);
  }

  @Get('cinemas/:cinemaId/occupancy')
  @ApiOperation({ summary: 'Occupancy for every show at a cinema in a window.' })
  cinemaOccupancy(
    @CurrentUser() user: RequestUser,
    @Param('cinemaId') cinemaId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.live.cinemaOccupancy(user, cinemaId, new Date(from), new Date(to));
  }

  @Get('cinemas/:cinemaId/reports/seat-overrides')
  @ApiOperation({ summary: 'Manual seat actions, who made them and why.' })
  overrideReport(
    @CurrentUser() user: RequestUser,
    @Param('cinemaId') cinemaId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.live.overrideReport(user, cinemaId, new Date(from), new Date(to));
  }
}
