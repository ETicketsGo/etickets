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
    q: { city?: string; genre?: string; q?: string },
  ) {
    return this.publicMovies.list(q);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Get a published movie by slug.' })
  getBySlug(@Param('slug') slug: string) {
    return this.publicMovies.getBySlug(slug);
  }
}
