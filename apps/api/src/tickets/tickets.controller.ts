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

  @Get(':id')
  @ApiOperation({ summary: 'Get a single ticket with a signed QR code.' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.tickets.getForUser(user, id);
  }
}
