import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, EventStatus, Role } from '@eticketsgo/shared-types';
import {
  createEventSchema,
  createSessionSchema,
  createTicketTypeSchema,
  updateTicketTypeSchema,
  paginationSchema,
  reviewDecisionSchema,
  type CreateSessionInput,
  type CreateTicketTypeInput,
  type UpdateTicketTypeInput,
  type ReviewDecisionInput,
} from '@eticketsgo/validation';
import { EventsService } from './events.service';
import { PublicEventsService } from './public-events.service';
import { RequiresAdmin, CurrentUser, Public, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const createEventBody = createEventSchema.extend({ organizationId: z.string().cuid() });
const updateEventBody = createEventSchema.partial();

@ApiTags('events')
@ApiBearerAuth()
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an event (draft).' })
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createEventBody)) body: z.infer<typeof createEventBody>,
  ) {
    const { organizationId, ...event } = body;
    return this.events.create(user, organizationId, event);
  }

  @Get()
  @ApiOperation({ summary: 'List an organization’s events.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.events.listForOrg(user, q.organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an event with sessions and ticket types.' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.events.getForOrg(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an editable event.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateEventBody)) body: z.infer<typeof updateEventBody>,
  ) {
    return this.events.update(user, id, body);
  }

  @Post(':id/sessions')
  @ApiOperation({ summary: 'Add a session to an event.' })
  addSession(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createSessionSchema)) body: CreateSessionInput,
  ) {
    return this.events.addSession(user, id, body);
  }

  @Post('ticket-types')
  @ApiOperation({ summary: 'Add a ticket type to a session.' })
  addTicketType(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createTicketTypeSchema)) body: CreateTicketTypeInput,
  ) {
    return this.events.addTicketType(user, body);
  }

  @Patch('ticket-types/:id')
  @ApiOperation({ summary: 'Edit a ticket type (price locked after sale; quantity only rises).' })
  updateTicketType(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTicketTypeSchema)) body: UpdateTicketTypeInput,
  ) {
    return this.events.updateTicketType(user, id, body);
  }

  @Delete('ticket-types/:id')
  @ApiOperation({ summary: 'Delete a ticket type with no sales/holds.' })
  deleteTicketType(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.events.deleteTicketType(user, id);
  }

  @Get(':id/orders')
  @ApiOperation({ summary: 'List bookings (orders) for an event.' })
  orders(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({ status: z.string().optional(), q: z.string().optional() }),
      ),
    )
    q: { page: number; pageSize: number; status?: string; q?: string },
  ) {
    return this.events.orders(user, id, q);
  }

  @Get(':id/attendees')
  @ApiOperation({ summary: 'List attendees (issued tickets) for an event.' })
  attendees(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({
          status: z.string().optional(),
          q: z.string().optional(),
          sessionId: z.string().optional(),
        }),
      ),
    )
    q: { page: number; pageSize: number; status?: string; q?: string; sessionId?: string },
  ) {
    return this.events.attendees(user, id, q);
  }

  @Post(':id/submit')
  @ApiOperation({ summary: 'Submit an event for admin review.' })
  submit(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.events.submitForReview(user, id);
  }

  @Post(':id/duplicate')
  @ApiOperation({
    summary: 'Duplicate an event (settings + sessions + ticket types) as a new draft.',
  })
  duplicate(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.events.duplicate(user, id);
  }

  @Get(':id/promotion')
  @ApiOperation({ summary: 'Marketing assets for an event: public URL and QR code.' })
  promotion(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.events.promotion(user, id);
  }

  @Post(':id/pause')
  @ApiOperation({ summary: 'Pause a published event.' })
  pause(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.events.setPaused(user, id, true);
  }

  @Post(':id/resume')
  @ApiOperation({ summary: 'Resume a paused event.' })
  resume(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.events.setPaused(user, id, false);
  }
}

@ApiTags('public')
@Controller('public/events')
export class PublicEventsController {
  constructor(private readonly publicEvents: PublicEventsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Browse and search published events.' })
  list(
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({
          q: z.string().optional(),
          city: z.string().optional(),
          category: z.string().optional(),
          dateFrom: z.coerce.date().optional(),
          dateTo: z.coerce.date().optional(),
        }),
      ),
    )
    q: {
      page: number;
      pageSize: number;
      q?: string;
      city?: string;
      category?: string;
      dateFrom?: Date;
      dateTo?: Date;
    },
  ) {
    return this.publicEvents.list(q);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Get a published event by slug.' })
  getBySlug(@Param('slug') slug: string) {
    return this.publicEvents.getBySlug(slug);
  }
}

@ApiTags('public')
@Controller('public/categories')
export class PublicCategoriesController {
  constructor(private readonly publicEvents: PublicEventsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Published-event categories with counts.' })
  list() {
    return this.publicEvents.categoriesWithCounts();
  }
}

@ApiTags('public')
@Controller('public/organizers')
export class PublicOrganizersController {
  constructor(private readonly publicEvents: PublicEventsService) {}

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Public organizer profile with published events.' })
  organizer(@Param('id') id: string) {
    return this.publicEvents.organizer(id);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.EVENT_REVIEW)
@Controller('admin/events')
export class AdminEventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @ApiOperation({ summary: 'List events for moderation (admin).' })
  list(
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({ status: z.nativeEnum(EventStatus).optional() }),
      ),
    )
    q: {
      page: number;
      pageSize: number;
      status?: EventStatus;
    },
  ) {
    return this.events.adminList(q.status, q.page, q.pageSize);
  }

  @Post(':id/review')
  @ApiOperation({ summary: 'Approve or reject an event under review (admin).' })
  review(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reviewDecisionSchema)) body: ReviewDecisionInput,
  ) {
    return this.events.review(admin, id, body);
  }

  @Post(':id/status')
  @ApiOperation({ summary: 'Pause or cancel an event (admin).' })
  setStatus(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ status: z.nativeEnum(EventStatus) })))
    body: { status: EventStatus },
  ) {
    return this.events.adminSetStatus(admin, id, body.status);
  }
}
