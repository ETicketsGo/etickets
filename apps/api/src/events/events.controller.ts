import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminPermission, EventStatus, Role } from '@eticketsgo/shared-types';
import {
  createEventSchema,
  createSessionSchema,
  createTicketTypeSchema,
  updateSessionSeatingSchema,
  updateTicketTypeSchema,
  paginationSchema,
  reviewDecisionSchema,
  type CreateSessionInput,
  type CreateTicketTypeInput,
  type UpdateSessionSeatingInput,
  type UpdateTicketTypeInput,
  type ReviewDecisionInput,
} from '@eticketsgo/validation';
import { EventsService } from './events.service';
import { PublicEventsService } from './public-events.service';
import { EventImageService, type UploadedImageFile } from './event-image.service';
import { EVENT_IMAGE_MAX_BYTES, eventImageVersion } from './event-image';
import { RequiresAdmin, CurrentUser, Public, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const createEventBody = createEventSchema.extend({ organizationId: z.string().cuid() });
const updateEventBody = createEventSchema.partial();

@ApiTags('events')
@ApiBearerAuth()
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly images: EventImageService,
  ) {}

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

  /*
    Declared before `@Get(':id')` on purpose. Nest matches routes in declaration order, so
    the reverse would make 'seating-rooms' arrive as an event id and 404.
  */
  @Get('seating-rooms')
  @ApiOperation({
    summary: 'Rooms an event can be seated in — this org’s rooms with a published seat map.',
  })
  seatingRooms(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.events.listSeatingRooms(user, q.organizationId);
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

  /*
    The event's image: one file, multipart. The size cap is enforced where multer reads the
    stream, so an oversized upload is refused with 413 before it is buffered in full.
  */
  @Put(':id/image')
  @ApiOperation({ summary: 'Upload or replace the event image (JPG, PNG or WebP, max 2 MB).' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: EVENT_IMAGE_MAX_BYTES, files: 1 } }),
  )
  uploadImage(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @UploadedFile() file?: UploadedImageFile,
  ) {
    return this.images.put(user, id, file);
  }

  @Delete(':id/image')
  @ApiOperation({ summary: 'Remove the event image.' })
  removeImage(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.images.remove(user, id);
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

  @Patch('sessions/:sessionId/seating')
  @ApiOperation({
    summary: 'Change, add or remove a session’s room. Refused once anything is sold or held.',
  })
  updateSessionSeating(
    @CurrentUser() user: RequestUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(updateSessionSeatingSchema)) body: UpdateSessionSeatingInput,
  ) {
    return this.events.updateSessionSeating(user, sessionId, body.screenId);
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

  /**
   * Whether a customer could actually complete a purchase for this event.
   *
   * Read-only, and available at any point in an event's life rather than only at publish.
   * A blocker can appear on a LIVE event -- a price edited above a ceiling, a seat map
   * replaced -- and an organizer needs to be able to ask the question then too, not only
   * once at the moment they submit.
   */
  @Get(':id/sellability')
  @ApiOperation({ summary: 'Blockers and warnings a customer would hit at checkout.' })
  async sellability(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.events.sellability(user, id);
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
  constructor(
    private readonly publicEvents: PublicEventsService,
    private readonly images: EventImageService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Browse and search published events.' })
  list(
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({
          q: z.string().optional(),
          city: z.string().optional(),
          // Either spelling — `IN` or `India`. Ignored when a city is given.
          country: z.string().trim().min(2).max(60).optional(),
          category: z.string().optional(),
          dateFrom: z.coerce.date().optional(),
          dateTo: z.coerce.date().optional(),
          // A query string carries text, so this stays a string here and is compared
          // below. Coercing it would make `?freeOnly=false` mean true, `'false'` being a
          // perfectly truthy string.
          freeOnly: z.enum(['true', 'false']).optional(),
        }),
      ),
    )
    q: {
      page: number;
      pageSize: number;
      q?: string;
      city?: string;
      country?: string;
      category?: string;
      dateFrom?: Date;
      dateTo?: Date;
      freeOnly?: 'true' | 'false';
    },
  ) {
    return this.publicEvents.list({ ...q, freeOnly: q.freeOnly === 'true' });
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Get a published event by slug.' })
  getBySlug(@Param('slug') slug: string) {
    return this.publicEvents.getBySlug(slug);
  }

  /**
   * An event's image, for any page that shows the event.
   *
   * Not throttled: a browse page asks for one per card, and the global per-IP limit exists for
   * requests that cost work, not for an immutable image a browser caches after the first load.
   *
   * Served with `Cross-Origin-Resource-Policy: cross-origin` because the storefront, console
   * and app are other origins, and helmet's default `same-origin` would block every `<img>`.
   * A locked-down CSP and `nosniff` mean the bytes can only ever be rendered as an image.
   */
  @Public()
  @SkipThrottle()
  @Get(':id/image')
  @ApiOperation({ summary: 'An event’s image.' })
  async image(
    @Param('id') id: string,
    @Query('v') version: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const image = await this.images.read(id);
    if (!image) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'This event has no image.' });
      return;
    }
    const current = eventImageVersion(image.sha256);
    const etag = `"${current}"`;
    res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      version === current ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }
    const bytes = Buffer.from(image.bytes);
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.status(200).end(bytes);
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
