import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createAddOnSchema,
  updateAddOnSchema,
  createBundleSchema,
  updateBundleSchema,
  type CreateAddOnInput,
  type UpdateAddOnInput,
  type CreateBundleInput,
  type UpdateBundleInput,
} from '@eticketsgo/validation';
import { AddOnsService } from './addons.service';
import { BundlesService } from './bundles.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('commerce')
@ApiBearerAuth()
@Controller()
export class CommerceController {
  constructor(
    private readonly addOns: AddOnsService,
    private readonly bundles: BundlesService,
  ) {}

  // ── Add-ons (organizer) ──
  @Get('events/:eventId/addons')
  @ApiOperation({ summary: 'List an event’s add-ons (organizer).' })
  listAddOns(@CurrentUser() user: RequestUser, @Param('eventId') eventId: string) {
    return this.addOns.listForEvent(user, eventId);
  }

  @Post('events/:eventId/addons')
  @ApiOperation({ summary: 'Create an add-on for an event.' })
  createAddOn(
    @CurrentUser() user: RequestUser,
    @Param('eventId') eventId: string,
    @Body(new ZodValidationPipe(createAddOnSchema)) body: CreateAddOnInput,
  ) {
    return this.addOns.create(user, eventId, body);
  }

  @Patch('addons/:id')
  @ApiOperation({ summary: 'Update an add-on.' })
  updateAddOn(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAddOnSchema)) body: UpdateAddOnInput,
  ) {
    return this.addOns.update(user, id, body);
  }

  @Delete('addons/:id')
  @ApiOperation({ summary: 'Delete an add-on (only if unsold).' })
  removeAddOn(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.addOns.remove(user, id);
  }

  // ── Bundles (organizer) ──
  @Get('events/:eventId/bundles')
  @ApiOperation({ summary: 'List an event’s bundles (organizer).' })
  listBundles(@CurrentUser() user: RequestUser, @Param('eventId') eventId: string) {
    return this.bundles.listForEvent(user, eventId);
  }

  @Post('events/:eventId/bundles')
  @ApiOperation({ summary: 'Create a bundle for an event.' })
  createBundle(
    @CurrentUser() user: RequestUser,
    @Param('eventId') eventId: string,
    @Body(new ZodValidationPipe(createBundleSchema)) body: CreateBundleInput,
  ) {
    return this.bundles.create(user, eventId, body);
  }

  @Patch('bundles/:id')
  @ApiOperation({ summary: 'Update a bundle.' })
  updateBundle(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateBundleSchema)) body: UpdateBundleInput,
  ) {
    return this.bundles.update(user, id, body);
  }

  @Delete('bundles/:id')
  @ApiOperation({ summary: 'Delete a bundle (only if unsold).' })
  removeBundle(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.bundles.remove(user, id);
  }
}

@ApiTags('public')
@Controller('public/events')
export class PublicCommerceController {
  constructor(
    private readonly addOns: AddOnsService,
    private readonly bundles: BundlesService,
  ) {}

  @Public()
  @Get(':eventId/addons')
  @ApiOperation({ summary: 'Purchasable add-ons for an event (public).' })
  addOnsForEvent(@Param('eventId') eventId: string) {
    return this.addOns.publicListForEvent(eventId);
  }

  @Public()
  @Get(':eventId/bundles')
  @ApiOperation({ summary: 'Purchasable bundles for an event (public).' })
  bundlesForEvent(@Param('eventId') eventId: string) {
    return this.bundles.publicListForEvent(eventId);
  }
}
