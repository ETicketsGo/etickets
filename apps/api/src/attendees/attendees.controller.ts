import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignAttendeeSchema,
  inviteAttendeeSchema,
  transferTicketSchema,
  type AssignAttendeeInput,
  type InviteAttendeeInput,
  type TransferTicketInput,
} from '@eticketsgo/validation';
import { AttendeesService } from './attendees.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('attendees')
@ApiBearerAuth()
@Controller()
export class AttendeesController {
  constructor(private readonly attendees: AttendeesService) {}

  @Post('tickets/:id/attendee')
  @ApiOperation({ summary: 'Assign an attendee to a ticket (booking owner).' })
  assign(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignAttendeeSchema)) body: AssignAttendeeInput,
  ) {
    return this.attendees.assign(user, id, body);
  }

  @Post('tickets/:id/invite')
  @ApiOperation({ summary: 'Invite an attendee to claim a ticket (booking owner).' })
  invite(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(inviteAttendeeSchema)) body: InviteAttendeeInput,
  ) {
    return this.attendees.invite(user, id, body);
  }

  @Post('tickets/:id/transfer')
  @ApiOperation({ summary: 'Transfer a ticket to another person (booking owner).' })
  transfer(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(transferTicketSchema)) body: TransferTicketInput,
  ) {
    return this.attendees.transfer(user, id, body);
  }

  @Post('tickets/:id/unassign')
  @ApiOperation({ summary: 'Clear a ticket’s attendee and rotate its QR (booking owner).' })
  unassign(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.attendees.unassign(user, id);
  }

  @Get('bookings/:id/attendees')
  @ApiOperation({ summary: 'Attendee assignment summary for a booking (owner or admin).' })
  summary(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.attendees.summaryForBooking(user, id);
  }

  @Post('attendee-invites/:token/accept')
  @ApiOperation({ summary: 'Accept an attendee invitation; rotates the ticket QR.' })
  accept(@CurrentUser() user: RequestUser, @Param('token') token: string) {
    return this.attendees.accept(user, token);
  }

  @Post('attendee-invites/:token/decline')
  @ApiOperation({ summary: 'Decline an attendee invitation.' })
  decline(@CurrentUser() user: RequestUser, @Param('token') token: string) {
    return this.attendees.decline(user, token);
  }

  @Post('attendee-invites/:id/resend')
  @ApiOperation({ summary: 'Re-issue a fresh claim link for a pending invite (owner).' })
  resend(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.attendees.resend(user, id);
  }
}
