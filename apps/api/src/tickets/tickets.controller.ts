import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import { CurrentUser, type RequestUser } from '../common/decorators';

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @ApiOperation({ summary: 'Ticket wallet — the current user’s tickets with QR codes.' })
  wallet(@CurrentUser() user: RequestUser) {
    return this.tickets.wallet(user);
  }

  @Get('booking/:bookingId/print')
  @ApiOperation({
    summary: 'Every ticket on a booking, for organizer staff printing at the counter.',
  })
  forBookingAsStaff(@CurrentUser() staff: RequestUser, @Param('bookingId') bookingId: string) {
    /*
      Declared before `@Get(':id')`. Nest matches in declaration order, so a route with a
      literal segment has to come first or `:id` swallows it — the ticket id would be the
      string "booking" and this would 404 with a message about a ticket nobody asked for.
    */
    return this.tickets.ticketsForBookingAsStaff(staff, bookingId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single ticket with a signed QR code.' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.tickets.getForUser(user, id);
  }
}
