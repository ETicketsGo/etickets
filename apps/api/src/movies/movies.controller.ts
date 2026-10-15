import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createMovieSchema,
  movieStatusSchema,
  updateMovieSchema,
  type MovieStatusInput,
  type UpdateMovieInput,
} from '@eticketsgo/validation';
import { MoviesService, PublicMoviesService } from './movies.service';
import { MOVIE_POSTER_MAX_BYTES, MoviePosterService } from './movie-poster.service';
import { sendEventImage } from '../events/events.controller';
import type { UploadedImageFile } from '../events/event-image.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const createMovieBody = createMovieSchema.extend({ organizationId: z.string().cuid() });

@ApiTags('movies')
@ApiBearerAuth()
@Controller('movies')
export class MoviesController {
  constructor(
    private readonly movies: MoviesService,
    private readonly posters: MoviePosterService,
  ) {}

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

  /*
    The film's poster, from the organizer's computer. One file, multipart; the cap is enforced
    where multer reads the stream, so an oversized upload is refused before it is buffered.
  */
  @Post(':id/poster')
  @ApiOperation({ summary: 'Upload the film’s poster (JPG, PNG or WebP, max 2 MB).' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MOVIE_POSTER_MAX_BYTES, files: 1 } }),
  )
  uploadPoster(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Req() req: Request,
    @UploadedFile() file?: UploadedImageFile,
  ) {
    // Behind Railway's proxy the scheme the browser used is in X-Forwarded-Proto.
    const proto =
      String(req.headers['x-forwarded-proto'] ?? '')
        .split(',')[0]
        .trim() || req.protocol;
    return this.posters.upload(user, id, file, `${proto}://${req.get('host')}`);
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
  country: z.string().trim().min(2).max(60).optional(),
  /** Inclusive lower bound. Clamped to now by the service — the past is never bookable. */
  from: z.coerce.date().optional(),
  /** Exclusive upper bound. */
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

@ApiTags('public')
@Controller('public/movies')
export class PublicMoviesController {
  constructor(
    private readonly publicMovies: PublicMoviesService,
    private readonly posters: MoviePosterService,
  ) {}

  /** A film's uploaded poster. Not throttled: a browse page asks for every card at once. */
  @Public()
  @SkipThrottle()
  @Get(':id/poster/:file')
  @ApiOperation({ summary: 'A film’s uploaded poster.' })
  async poster(
    @Param('id') id: string,
    @Param('file') file: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const image = await this.posters.read(id, file);
    // The file name carries the hash, so a found poster is always the current version.
    sendEventImage(res, image, image?.version, ifNoneMatch);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Browse published movies.' })
  list(
    @Query(
      new ZodValidationPipe(
        z.object({
          city: z.string().optional(),
          country: z.string().trim().min(2).max(60).optional(),
          genre: z.string().optional(),
          q: z.string().optional(),
        }),
      ),
    )
    q: {
      city?: string;
      country?: string;
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
    query: { city?: string; country?: string; from?: Date; to?: Date; limit: number },
  ) {
    return this.publicMovies.shows(slug, query);
  }
}
