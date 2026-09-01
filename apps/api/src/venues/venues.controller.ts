import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  createVenueSchema,
  updateVenueSchema,
  type CreateVenueInput,
  type UpdateVenueInput,
} from '@eticketsgo/validation';
import { VenuesService } from './venues.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const createVenueBody = createVenueSchema.extend({ organizationId: z.string().cuid() });

@ApiTags('venues')
@ApiBearerAuth()
@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a venue for an organization.' })
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createVenueBody))
    body: CreateVenueInput & { organizationId: string },
  ) {
    const { organizationId, ...venue } = body;
    return this.venues.create(user, organizationId, venue);
  }

  @Get()
  @ApiOperation({ summary: 'List venues for an organization.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.venues.list(user, q.organizationId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a venue.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateVenueSchema)) body: UpdateVenueInput,
  ) {
    return this.venues.update(user, id, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a venue.' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.venues.get(user, id);
  }
}
