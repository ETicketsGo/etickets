import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  generateSeatMapSchema,
  scheduleShowSchema,
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
