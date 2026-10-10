import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrganizerCalendarService } from './organizer-calendar.service';
import {
  OrganizerSaleEligibilityService,
  SALE_ELIGIBILITY_MAX_EVENTS,
  SALE_ELIGIBILITY_MAX_SESSIONS,
} from './organizer-sale-eligibility.service';

const calendarQuery = z.object({
  organizationId: z.string().cuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

/** The comma-separated ids of the query, without blanks. */
function splitIds(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const eligibilityQuery = z.object({
  organizationId: z.string().cuid(),
  /** Comma-separated show ids. */
  sessionIds: z
    .string()
    .max(SALE_ELIGIBILITY_MAX_SESSIONS * 32)
    .refine(
      (v) => splitIds(v).every((id) => z.string().cuid().safeParse(id).success),
      'Each show id must be an id.',
    ),
});

const eventEligibilityQuery = z.object({
  organizationId: z.string().cuid(),
  /** Comma-separated event ids. */
  eventIds: z
    .string()
    .max(SALE_ELIGIBILITY_MAX_EVENTS * 32)
    .refine(
      (v) => splitIds(v).every((id) => z.string().cuid().safeParse(id).success),
      'Each event id must be an id.',
    ),
});

/*
  Its own path rather than `/events/calendar`: under `/events` it would have to be declared
  ahead of `GET /events/:id` in that controller, and a later route added above it would
  quietly turn "calendar" into an event id.
*/
@ApiTags('events')
@ApiBearerAuth()
@Controller('organizer-calendar')
export class OrganizerCalendarController {
  constructor(
    private readonly calendar: OrganizerCalendarService,
    private readonly saleEligibility: OrganizerSaleEligibilityService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Every session of an organization that touches a window of time (at most 62 days).',
  })
  sessions(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(calendarQuery)) q: z.infer<typeof calendarQuery>,
  ) {
    return this.calendar.sessions(user, q.organizationId, new Date(q.from), new Date(q.to));
  }

  /*
    Declared on this controller, under its own literal path, for the same reason as the
    calendar: nothing here can be read as an id. Read-only. See the service for why it exists.
  */
  @Get('sale-eligibility')
  @ApiOperation({
    summary: 'Whether checkout would sell each of these shows now, with the organizer reason.',
  })
  eligibility(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(eligibilityQuery)) q: z.infer<typeof eligibilityQuery>,
  ) {
    return this.saleEligibility.forSessions(user, q.organizationId, splitIds(q.sessionIds));
  }

  /** Read-only, like the per-show read above, and scoped the same way. */
  @Get('event-sale-eligibility')
  @ApiOperation({
    summary:
      'Whether each of these events is selling, partly selling or not selling, over its upcoming shows.',
  })
  eventEligibility(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(eventEligibilityQuery)) q: z.infer<typeof eventEligibilityQuery>,
  ) {
    return this.saleEligibility.forEvents(user, q.organizationId, splitIds(q.eventIds));
  }
}
