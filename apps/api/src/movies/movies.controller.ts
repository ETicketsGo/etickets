import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  createMovieSchema,
  movieStatusSchema,
  updateMovieSchema,
  type MovieStatusInput,
  type UpdateMovieInput,
} from '@eticketsgo/validation';
import { MoviesService, PublicMoviesService } from './movies.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const createMovieBody = createMovieSchema.extend({ organizationId: z.string().cuid() });

@ApiTags('movies')
@ApiBearerAuth()
@Controller('movies')
export class MoviesController {
  constructor(private readonly movies: MoviesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a movie (catalogue entry).' })
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createMovieBody)) body: z.infer<typeof createMovieBody>,
  ) {
    const { organizationId, ...movie } = body;
    return this.movies.create(user, organizationId, movie);
  }

  @Get()
  @ApiOperation({ summary: 'List an organization’s movies.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.movies.listForOrg(user, q.organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a movie.' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.movies.getForOrg(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a movie.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateMovieSchema)) body: UpdateMovieInput,
  ) {
    return this.movies.update(user, id, body);
  }

  @Post(':id/status')
  @ApiOperation({ summary: 'Set a movie’s catalogue status.' })
  setStatus(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(movieStatusSchema)) body: MovieStatusInput,
  ) {
    return this.movies.setStatus(user, id, body.status);
  }
}

/**
 * Query for GET /public/movies/:slug/shows.
 *
 * `limit` is capped again in the service. Validating here gives a clean 400 for a
 * nonsense value; capping there means no route into the query can request an unbounded
 * scan, whatever a future caller does.
 */
const showsQuerySchema = z.object({
  city: z.string().trim().min(1).max(80).optional(),
  /** Inclusive lower bound. Clamped to now by the service — the past is never bookable. */
  from: z.coerce.date().optional(),
  /** Exclusive upper bound. */
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

@ApiTags('public')
@Controller('public/movies')
export class PublicMoviesController {
  constructor(private readonly publicMovies: PublicMoviesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Browse published movies.' })
  list(
    @Query(
      new ZodValidationPipe(
        z.object({
          city: z.string().optional(),
          genre: z.string().optional(),
          q: z.string().optional(),
        }),
      ),
    )
    q: {
      city?: string;
      genre?: string;
      q?: string;
    },
  ) {
    return this.publicMovies.list(q);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Get a published movie by slug.' })
  getBySlug(@Param('slug') slug: string) {
    return this.publicMovies.getBySlug(slug);
  }

  @Public()
  @Get(':slug/shows')
  @ApiOperation({
    summary: 'Bookable screenings of a published film, with pricing and availability.',
    description:
      'Complements GET /public/movies/:slug, which returns shows grouped by cinema but ' +
      'nothing about buying. Each row here carries price, currency, availability ' +
      '(AVAILABLE | LIMITED | SOLD_OUT), seating type, format and city, plus eventSlug ' +
      'and sessionId to continue into /public/events/:slug and ' +
      '/public/shows/:sessionId/seats. Only screenings a customer can buy: film ' +
      'PUBLISHED, listing PUBLISHED, session SCHEDULED, start time in the future. A film ' +
      'with nothing on returns an empty list, not a 404. Times are ISO instants — no ' +
      'venue timezone exists in the schema, so the server does not invent a local date.',
  })
  shows(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(showsQuerySchema))
    query: { city?: string; from?: Date; to?: Date; limit: number },
  ) {
    return this.publicMovies.shows(slug, query);
  }
}
