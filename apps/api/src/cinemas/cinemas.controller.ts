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
import { PilotReadinessService } from './pilot-readiness.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CinemaComplianceService } from './cinema-compliance.service';

const createCinemaBody = createCinemaSchema.extend({ organizationId: z.string().cuid() });

@ApiTags('cinemas')
@ApiBearerAuth()
@Controller('cinemas')
export class CinemasController {
  constructor(
    private readonly cinemas: CinemasService,
    private readonly readiness: PilotReadinessService,
    private readonly compliance: CinemaComplianceService,
  ) {}

  @Get(':id/seat-classes')
  @ApiOperation({
    summary: 'Every sellable seat category and the regulatory class it is mapped to.',
  })
  seatClasses(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.compliance.seatClassesFor(user, id);
  }

  @Patch(':id/seat-classes/:seatCategoryId')
  @ApiOperation({
    summary: 'Map a seat category to a regulatory seat class (or clear the mapping).',
  })
  setSeatClass(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('seatCategoryId') seatCategoryId: string,
    @Body() body: { regulatoryClass: string | null },
  ) {
    /*
      The operator states the mapping; the platform never infers it from the category's name.
      Clearing it back to null is deliberate and permitted — withdrawing a wrong answer must be
      possible, and in a regulated jurisdiction the seat then stops selling until it is mapped
      again, which is the correct consequence of not knowing.
    */
    return this.compliance.setSeatClass(user, id, seatCategoryId, body?.regulatoryClass ?? null);
  }

  @Get(':id/pricing-compliance')
  @ApiOperation({
    summary: 'The pricing order this cinema is sold under, and whether its prices comply.',
  })
  pricingCompliance(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    /*
      EXPLANATORY. Booking and publishing each enforce on their own; this exists so an
      organizer learns why before they hit the wall rather than after. A client that never
      calls it is not a client that can sell at any price.
    */
    return this.compliance.forCinema(user, id);
  }

  @Get(':id/pilot-readiness')
  @ApiOperation({
    summary: 'Whether this cinema can open, and precisely what is stopping it.',
  })
  pilotReadiness(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.readiness.evaluate(user, id);
  }

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
