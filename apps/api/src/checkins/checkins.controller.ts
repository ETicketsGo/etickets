import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { CheckinsService } from './checkins.service';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const scanSchema = z.object({
  token: z.string().min(1),
  expectedSessionId: z.string().cuid().optional(),
  deviceInfo: z.string().max(200).optional(),
});
const reverseSchema = z.object({ ticketId: z.string().cuid() });
const visualSchema = z.object({
  ticketId: z.string().cuid(),
  expectedSessionId: z.string().cuid().optional(),
  deviceInfo: z.string().max(200).optional(),
});
const findBookingsSchema = z.object({
  organizationId: z.string().cuid(),
  q: z.string().trim().min(3).max(80),
});
const rosterSchema = z.object({
  eventSessionId: z.string().cuid(),
  /** Free text: a seat, a name, a booking reference, part of a serial. */
  q: z.string().trim().max(80).optional(),
});

@ApiTags('checkins')
@ApiBearerAuth()
@Roles(
  Role.CHECKIN_STAFF,
  Role.ORGANIZER_MANAGER,
  Role.ORGANIZER_OWNER,
  Role.ADMIN,
  Role.SUPER_ADMIN,
)
@Controller('checkins')
export class CheckinsController {
  constructor(private readonly checkins: CheckinsService) {}

  @Post()
  @ApiOperation({ summary: 'Scan and check in a ticket by QR token.' })
  scan(
    @CurrentUser() staff: RequestUser,
    @Body(new ZodValidationPipe(scanSchema)) body: z.infer<typeof scanSchema>,
  ) {
    return this.checkins.scan(staff, body.token, {
      expectedSessionId: body.expectedSessionId,
      deviceInfo: body.deviceInfo,
    });
  }

  @Get('roster')
  @ApiOperation({
    summary: 'Tickets for a session, so staff can find the one in front of them by eye.',
  })
  roster(
    @CurrentUser() staff: RequestUser,
    @Query(new ZodValidationPipe(rosterSchema)) q: z.infer<typeof rosterSchema>,
  ) {
    return this.checkins.roster(staff, q.eventSessionId, q.q);
  }

  @Get('bookings')
  @ApiOperation({
    summary: 'Find a booking across the organization, for the box office counter.',
  })
  findBookings(
    @CurrentUser() staff: RequestUser,
    @Query(new ZodValidationPipe(findBookingsSchema)) q: z.infer<typeof findBookingsSchema>,
  ) {
    return this.checkins.findBookings(staff, q.organizationId, q.q);
  }

  @Post('visual')
  @ApiOperation({
    summary: 'Admit a ticket identified by eye rather than scanned. Recorded as a visual check.',
  })
  visual(
    @CurrentUser() staff: RequestUser,
    @Body(new ZodValidationPipe(visualSchema)) body: z.infer<typeof visualSchema>,
  ) {
    /*
      Same roles as a scan. Someone standing at the door with a torch is doing the job whether
      or not a scanner is involved, and requiring a manager to admit visually would mean the
      venues that admit that way — most of them, in India — could not use this at all.
    */
    return this.checkins.admitVisually(staff, body.ticketId, {
      expectedSessionId: body.expectedSessionId,
      deviceInfo: body.deviceInfo,
    });
  }

  @Post('reverse')
  @Roles(Role.ORGANIZER_MANAGER, Role.ORGANIZER_OWNER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Reverse a check-in (authorized roles only).' })
  reverse(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(reverseSchema)) body: { ticketId: string },
  ) {
    return this.checkins.reverse(user, body.ticketId);
  }
}
