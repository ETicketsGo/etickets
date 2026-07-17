import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createCouponSchema,
  updateCouponSchema,
  type CreateCouponInput,
  type UpdateCouponInput,
} from '@eticketsgo/validation';
import { CouponsService } from './coupons.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/** Organizer discount-code management (org-scoped, manager/owner only). */
@ApiTags('coupons')
@ApiBearerAuth()
@Controller('coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @ApiOperation({ summary: 'List an organization’s discount codes (paginated).' })
  list(
    @CurrentUser() user: RequestUser,
    @Query('organizationId') organizationId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.coupons.list(
      user,
      organizationId,
      page ? Number(page) : undefined,
      pageSize ? Number(pageSize) : undefined,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a discount code.' })
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createCouponSchema)) body: CreateCouponInput,
  ) {
    return this.coupons.create(user, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a discount code (value/window/limit/active).' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCouponSchema)) body: UpdateCouponInput,
  ) {
    return this.coupons.update(user, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an unredeemed discount code.' })
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.coupons.remove(user, id);
  }
}
