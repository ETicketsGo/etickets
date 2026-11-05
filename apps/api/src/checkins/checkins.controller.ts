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
  /** The event whose check-in page is open: another event's ticket is refused. */
  expectedEventId: z.string().cuid().optional(),
  deviceInfo: z.string().max(200).optional(),
});
const reverseSchema = z.object({ ticketId: z.string().cuid() });
const visualSchema = z.object({
  ticketId: z.string().cuid(),
  expectedSessionId: z.string().cuid().optional(),
  /** The event whose check-in page is open: another event's ticket is refused. */
  expectedEventId: z.string().cuid().optional(),
  deviceInfo: z.string().max(200).optional(),
});
const findBookingsSchema = z.object({
  organizationId: z.string().cuid(),
  q: z.string().trim().min(3).max(80),
});
const recentBookingsSchema = z.object({
  organizationId: z.string().cuid(),
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  eventId: z.string().cuid().optional(),
  /** Comma-separated booking statuses; abandoned holds are left out by default. */
  status: z.string().trim().max(200).optional(),
  q: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const gateSessionsSchema = z.object({ organizationId: z.string().cuid() });
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
      expectedEventId: body.expectedEventId,
      deviceInfo: body.deviceInfo,
    });
  }

  @Get('sessions')
  @Roles(
    Role.ORGANIZER_OWNER,
    Role.ORGANIZER_MANAGER,
    Role.CHECKIN_STAFF,
    Role.ADMIN,
    Role.SUPER_ADMIN,
  )
  @ApiOperation({ summary: 'Shows this organization is running now, for the gate to pick from.' })
  async gateSessions(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(gateSessionsSchema)) q: { organizationId: string },
  ) {
    return this.checkins.gateSessions(user, q.organizationId);
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

  @Get('bookings/recent')
  @ApiOperation({
    summary: "The organization's bookings, newest first, a page at a time (no contact details).",
  })
  recentBookings(
    @CurrentUser() staff: RequestUser,
    @Query(new ZodValidationPipe(recentBookingsSchema)) q: z.infer<typeof recentBookingsSchema>,
  ) {
    const allowed = new Set([
      'PENDING_PAYMENT',
      'CONFIRMED',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'CANCELLED',
      'EXPIRED',
      'DISPUTED',
    ]);
    const status = q.status
      ?.split(',')
      .map((v) => v.trim().toUpperCase())
      .filter((v) => allowed.has(v));
    return this.checkins.listRecentBookings(staff, q.organizationId, { ...q, status });
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
      expectedEventId: body.expectedEventId,
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
