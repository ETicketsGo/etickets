import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@eticketsgo/shared-types';
import { counterSaleSchema, type CounterSaleInput } from '@eticketsgo/validation';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrganizerOnly } from '../tenancy/organizer-only.guard';
import { CounterSalesService } from './counter-sales.service';

@ApiTags('counter')
@Controller('organizations')
export class CounterSalesController {
  constructor(private readonly counter: CounterSalesService) {}

  /** The dates on sale now, with ticket types and what is left, for the counter's form. */
  @Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF)
  @OrganizerOnly('counter.sell')
  @Get(':id/counter-sales/shows')
  @ApiOperation({ summary: 'What can be sold at the counter now.' })
  shows(@CurrentUser() user: RequestUser, @Param('id') organizationId: string) {
    return this.counter.shows(user, organizationId);
  }

  /*
    A walk-up sale at the box office. The same three roles as Collect at the counter, because
    at a small venue the person on the door is the person with the cash tin; membership of THIS
    organization is asserted in the service. Never platform staff: it issues tickets against
    money only the venue saw.
  */
  @Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF)
  @OrganizerOnly('counter.sell')
  @Post(':id/counter-sales')
  @ApiOperation({ summary: 'Sell tickets at the counter for cash, and issue them at once.' })
  sell(
    @CurrentUser() user: RequestUser,
    @Param('id') organizationId: string,
    @Body(new ZodValidationPipe(counterSaleSchema)) body: CounterSaleInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.counter.sell(user, organizationId, body, idempotencyKey);
  }
}
