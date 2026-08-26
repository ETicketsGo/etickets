import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import {
  settlementBlockSchema,
  settlementListSchema,
  settlementReleaseSchema,
  type SettlementBlockInput,
  type SettlementListInput,
  type SettlementReleaseInput,
} from '@eticketsgo/validation';
import { SettlementService } from './settlement.service';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PAYOUT_MANAGE)
@Controller('admin/settlements')
export class SettlementController {
  constructor(private readonly settlements: SettlementService) {}

  @Get()
  @ApiOperation({ summary: 'List organizer settlements (admin/finance).' })
  list(@Query(new ZodValidationPipe(settlementListSchema)) q: SettlementListInput) {
    return this.settlements.list(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Settlement detail + linked payments (admin/finance).' })
  get(@Param('id') id: string) {
    return this.settlements.get(id);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve an eligible settlement for release.' })
  approve(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.settlements.approve(user, id);
  }

  @Post(':id/release')
  @ApiOperation({ summary: 'Release an approved settlement (idempotent transfer).' })
  release(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(settlementReleaseSchema)) body: SettlementReleaseInput,
  ) {
    return this.settlements.release(user, id, body.note);
  }

  @Post(':id/block')
  @ApiOperation({ summary: 'Block a settlement (dispute/fraud/review hold).' })
  block(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(settlementBlockSchema)) body: SettlementBlockInput,
  ) {
    return this.settlements.block(user, id, body.reason);
  }
}
