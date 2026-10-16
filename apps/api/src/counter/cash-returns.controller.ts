import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@eticketsgo/shared-types';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { OrganizerOnly } from '../tenancy/organizer-only.guard';
import { CashReturnsService } from '../refunds/cash-returns.service';

/*
  Cash to hand back at the counter after a show was cancelled. The same three roles that take
  cash at the counter, because the person who hands it back is the person with the cash tin;
  membership of THIS organization is asserted in the service. Never platform staff: the money
  only ever crossed the venue's counter. Nothing here calls a payment provider.
*/
@ApiTags('counter')
@Controller('organizations')
export class CashReturnsController {
  constructor(private readonly cash: CashReturnsService) {}

  @Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF)
  @OrganizerOnly('counter.cash-returns')
  @Get(':id/cash-returns')
  @ApiOperation({ summary: 'Cash owed back for cancelled cash bookings.' })
  list(
    @CurrentUser() user: RequestUser,
    @Param('id') organizationId: string,
    @Query('eventId') eventId?: string,
    @Query('includeReturned') includeReturned?: string,
  ) {
    return this.cash.list(user, organizationId, {
      eventId: eventId || undefined,
      includeReturned: includeReturned === 'true',
    });
  }

  @Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF)
  @OrganizerOnly('counter.cash-returns')
  @Post(':id/cash-returns/:bookingId/returned')
  @ApiOperation({ summary: 'Record that the cash for a cancelled booking was handed back.' })
  markReturned(
    @CurrentUser() user: RequestUser,
    @Param('id') organizationId: string,
    @Param('bookingId') bookingId: string,
  ) {
    return this.cash.markReturned(user, organizationId, bookingId);
  }
}
