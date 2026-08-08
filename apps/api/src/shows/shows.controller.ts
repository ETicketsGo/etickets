import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  bulkScheduleShowsSchema,
  cancelShowSchema,
  copyScheduleSchema,
  rescheduleShowSchema,
  showSalesActionSchema,
  generateSeatMapSchema,
  scheduleShowSchema,
  type BulkScheduleShowsInput,
  type CancelShowInput,
  type CopyScheduleInput,
  type RescheduleShowInput,
  type ShowSalesActionInput,
  type GenerateSeatMapInput,
  type ScheduleShowInput,
} from '@eticketsgo/validation';
import { ShowsService } from './shows.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('shows')
@ApiBearerAuth()
@Controller()
export class ShowsController {
  constructor(private readonly shows: ShowsService) {}

  @Post('screens/:screenId/seatmap')
  @ApiOperation({ summary: 'Generate a seat map for a screen.' })
  generateSeatMap(
    @CurrentUser() user: RequestUser,
    @Param('screenId') screenId: string,
    @Body(new ZodValidationPipe(generateSeatMapSchema)) body: GenerateSeatMapInput,
  ) {
    return this.shows.generateSeatMap(user, screenId, body);
  }

  @Get('screens/:screenId/seatmap')
  @ApiOperation({ summary: 'Get a screen’s seat map.' })
  getSeatMap(@CurrentUser() user: RequestUser, @Param('screenId') screenId: string) {
    return this.shows.getSeatMap(user, screenId);
  }

  @Post('movies/:movieId/shows')
  @ApiOperation({ summary: 'Schedule a movie show (session) on a screen.' })
  scheduleShow(
    @CurrentUser() user: RequestUser,
    @Param('movieId') movieId: string,
    @Body(new ZodValidationPipe(scheduleShowSchema)) body: ScheduleShowInput,
  ) {
    return this.shows.scheduleShow(user, movieId, body);
  }

  /**
   * Schedule a day, a week or a run in one request.
   *
   * Extends the existing scheduling surface rather than introducing a competing one: the
   * single-show POST above stays the simple path, and this is the same operation applied to
   * a grid of times. Defaults to a dry run, so a mistaken call previews rather than creates.
   */
  @Post('movies/:movieId/shows/bulk')
  @ApiOperation({
    summary: 'Preview or create many shows at once (dry run by default).',
  })
  bulkScheduleShows(
    @CurrentUser() user: RequestUser,
    @Param('movieId') movieId: string,
    @Body(new ZodValidationPipe(bulkScheduleShowsSchema)) body: BulkScheduleShowsInput,
  ) {
    return this.shows.bulkScheduleShows(user, movieId, body);
  }

  /**
   * Copy a screen's day onto another date and/or another screen. Dry run by default.
   *
   * One endpoint for both, because they are the same operation: the target screen simply
   * defaults to the source. Splitting them would duplicate every compatibility check.
   */
  @Post('movies/:movieId/shows/copy')
  @ApiOperation({ summary: 'Copy a day’s schedule to another date and/or screen.' })
  copySchedule(
    @CurrentUser() user: RequestUser,
    @Param('movieId') movieId: string,
    @Body(new ZodValidationPipe(copyScheduleSchema)) body: CopyScheduleInput,
  ) {
    return this.shows.copySchedule(user, movieId, body);
  }

  /**
   * Sales control for one show. Separate verbs rather than a generic status PATCH: each has
   * different preconditions, and "set status to CANCELLED" hides that cancelling is a
   * different kind of act from pausing.
   */
  @Post('shows/:sessionId/pause')
  @ApiOperation({ summary: 'Stop selling a show without cancelling it.' })
  pauseSales(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(showSalesActionSchema)) body: ShowSalesActionInput,
  ) {
    return this.shows.pauseSales(user, sessionId, body.reason);
  }

  @Post('shows/:sessionId/reopen')
  @ApiOperation({ summary: 'Put a paused show back on sale.' })
  reopenSales(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(showSalesActionSchema)) body: ShowSalesActionInput,
  ) {
    return this.shows.reopenSales(user, sessionId, body.reason);
  }

  @Post('shows/:sessionId/cancel')
  @ApiOperation({
    summary: 'Cancel a show. Returns bookings that need the refund workflow.',
  })
  cancelShow(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(cancelShowSchema)) body: CancelShowInput,
  ) {
    return this.shows.cancelShow(user, sessionId, body.reason);
  }

  @Post('shows/:sessionId/reschedule')
  @ApiOperation({ summary: 'Move a future show to a new start time.' })
  rescheduleShow(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(rescheduleShowSchema)) body: RescheduleShowInput,
  ) {
    return this.shows.rescheduleShow(user, sessionId, body);
  }

  /**
   * A cinema's schedule for one local day — the organizer's landing view.
   *
   * Additive: the per-movie listing below is unchanged. An operator thinks "what is on
   * Screen 2 today", not "where is this film playing", and assembling that client-side from
   * every film would be slow and let the two views disagree.
   */
  @Get('cinemas/:cinemaId/schedule')
  @ApiOperation({ summary: 'Shows on a cinema’s screens for one local day.' })
  cinemaSchedule(
    @CurrentUser() user: RequestUser,
    @Param('cinemaId') cinemaId: string,
    @Query('date') date: string,
    @Query('timezone') timezone?: string,
  ) {
    return this.shows.cinemaSchedule(user, cinemaId, {
      date,
      timezone: timezone || 'Asia/Kolkata',
    });
  }

  @Get('movies/:movieId/shows')
  @ApiOperation({ summary: 'List a movie’s scheduled shows.' })
  listShows(@CurrentUser() user: RequestUser, @Param('movieId') movieId: string) {
    return this.shows.listShows(user, movieId);
  }
}

@ApiTags('public')
@Controller('public/shows')
export class PublicShowsController {
  constructor(private readonly shows: ShowsService) {}

  @Public()
  @Get(':sessionId/seats')
  @ApiOperation({ summary: 'Get the seat layout for a show.' })
  seats(@Param('sessionId') sessionId: string) {
    return this.shows.getPublicSeatLayout(sessionId);
  }
}
