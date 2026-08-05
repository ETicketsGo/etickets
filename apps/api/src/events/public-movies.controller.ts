import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PublicMoviesService } from './public-movies.service';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * Query for GET /public/movies/:slug/shows.
 *
 * `limit` is capped again in the service. Validating here gives the caller a clean 400
 * for a nonsense value; capping there means no route into the query can ask the
 * database for an unbounded scan, whatever a future caller does.
 */
const showsQuerySchema = z.object({
  city: z.string().trim().min(1).max(80).optional(),
  /** Inclusive lower bound. Clamped to "now" by the service — the past is never bookable. */
  from: z.coerce.date().optional(),
  /** Exclusive upper bound. */
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

@ApiTags('public')
@Controller('public/movies')
export class PublicMoviesController {
  constructor(private readonly movies: PublicMoviesService) {}

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Public catalogue metadata for a published film.',
    description:
      'Catalogue data only — no organizer, tenant, status or pricing configuration. ' +
      'Returns 404 for a film that does not exist, is DRAFT, or is ARCHIVED; the three ' +
      'are deliberately indistinguishable so the catalogue pipeline is not exposed.',
  })
  @ApiParam({ name: 'slug', example: 'skyfront-protocol' })
  @ApiResponse({ status: 200, description: 'The film.' })
  @ApiResponse({ status: 404, description: 'MOVIE_NOT_PUBLISHED' })
  get(@Param('slug') slug: string) {
    return this.movies.getBySlug(slug);
  }

  @Public()
  @Get(':slug/shows')
  @ApiOperation({
    summary: 'Bookable screenings of a published film.',
    description:
      'Only screenings a customer can actually buy: film PUBLISHED, listing event ' +
      'PUBLISHED, session SCHEDULED, start time in the future. A film with nothing on ' +
      'returns an empty list, not a 404. Each row carries the grouping keys the client ' +
      'needs (date, venue/cinema, language, format) plus `eventSlug` and `sessionId` to ' +
      'continue into /public/events/:slug and /public/shows/:sessionId/seats. ' +
      'Times are ISO instants: no venue timezone exists in the schema, so the server ' +
      'does not invent a local calendar date — clients group in the viewer’s zone.',
  })
  @ApiParam({ name: 'slug', example: 'skyfront-protocol' })
  @ApiQuery({ name: 'city', required: false, example: 'Bengaluru' })
  @ApiQuery({ name: 'from', required: false, description: 'ISO instant; clamped to now.' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO instant, exclusive.' })
  @ApiQuery({ name: 'limit', required: false, description: '1–200, default 100.' })
  @ApiResponse({ status: 200, description: 'Film plus its bookable screenings.' })
  @ApiResponse({ status: 404, description: 'MOVIE_NOT_PUBLISHED' })
  shows(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(showsQuerySchema))
    query: { city?: string; from?: Date; to?: Date; limit: number },
  ) {
    return this.movies.showsBySlug(slug, query);
  }
}
