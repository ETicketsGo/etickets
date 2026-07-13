import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  createCinemaSchema,
  createScreenSchema,
  updateCinemaSchema,
  updateScreenSchema,
  type CreateScreenInput,
  type UpdateCinemaInput,
  type UpdateScreenInput,
} from '@eticketsgo/validation';
import { CinemasService } from './cinemas.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const createCinemaBody = createCinemaSchema.extend({ organizationId: z.string().cuid() });

@ApiTags('cinemas')
@ApiBearerAuth()
@Controller('cinemas')
export class CinemasController {
  constructor(private readonly cinemas: CinemasService) {}

  @Post()
  @ApiOperation({ summary: 'Create a cinema for an organization.' })
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createCinemaBody)) body: z.infer<typeof createCinemaBody>,
  ) {
    const { organizationId, ...cinema } = body;
    return this.cinemas.create(user, organizationId, cinema);
  }

  @Get()
  @ApiOperation({ summary: 'List an organization’s cinemas.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.cinemas.listForOrg(user, q.organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a cinema with its screens.' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.cinemas.getForOrg(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a cinema.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCinemaSchema)) body: UpdateCinemaInput,
  ) {
    return this.cinemas.update(user, id, body);
  }

  @Get(':cinemaId/screens')
  @ApiOperation({ summary: 'List a cinema’s screens.' })
  screens(@CurrentUser() user: RequestUser, @Param('cinemaId') cinemaId: string) {
    return this.cinemas.listScreens(user, cinemaId);
  }

  @Post(':cinemaId/screens')
  @ApiOperation({ summary: 'Add a screen to a cinema.' })
  addScreen(
    @CurrentUser() user: RequestUser,
    @Param('cinemaId') cinemaId: string,
    @Body(new ZodValidationPipe(createScreenSchema)) body: CreateScreenInput,
  ) {
    return this.cinemas.addScreen(user, cinemaId, body);
  }
}

@ApiTags('cinemas')
@ApiBearerAuth()
@Controller('screens')
export class ScreensController {
  constructor(private readonly cinemas: CinemasService) {}

  @Patch(':id')
  @ApiOperation({ summary: 'Update a screen.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateScreenSchema)) body: UpdateScreenInput,
  ) {
    return this.cinemas.updateScreen(user, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a screen.' })
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.cinemas.removeScreen(user, id);
  }
}
