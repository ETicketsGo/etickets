import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { PayoutsService } from './payouts.service';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('payouts')
@ApiBearerAuth()
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @ApiOperation({ summary: 'List payouts for an organization.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ organizationId: z.string().cuid() })))
    q: { organizationId: string },
  ) {
    return this.payouts.listForOrg(user, q.organizationId);
  }

  @Post('generate')
  @Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Generate a settlement payout for an organization/event.' })
  generate(
    @CurrentUser() user: RequestUser,
    @Body(
      new ZodValidationPipe(
        z.object({ organizationId: z.string().cuid(), eventId: z.string().cuid().optional() }),
      ),
    )
    body: { organizationId: string; eventId?: string },
  ) {
    return this.payouts.generate(user, body.organizationId, body.eventId);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PAYOUT_MANAGE)
@Controller('admin/payouts')
export class AdminPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @ApiOperation({ summary: 'List all payouts (admin).' })
  list() {
    return this.payouts.adminList();
  }

  @Post(':id/pay')
  @ApiOperation({ summary: 'Mark a payout as paid (admin).' })
  pay(@CurrentUser() admin: RequestUser, @Param('id') id: string) {
    return this.payouts.markPaid(admin, id);
  }
}
