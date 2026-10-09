import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrganizerCalendarService } from './organizer-calendar.service';

const calendarQuery = z.object({
  organizationId: z.string().cuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
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
  constructor(private readonly calendar: OrganizerCalendarService) {}

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
}
