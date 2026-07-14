import { Body, Controller, Get, Ip, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PAYMENT_ENVS, type PaymentEnvName } from '../configuration/payment-environment';
import { PromotionService } from './promotion.service';

const envSchema = z.enum(PAYMENT_ENVS);
const createSchema = z.object({
  fromEnv: envSchema,
  toEnv: envSchema,
  provider: z.enum(['stripe', 'razorpay', 'paypal', 'square']),
});

/**
 * Environment-promotion console (ADR-026). ADMIN/SUPER_ADMIN only. Preview a
 * promotion report, request a promotion, approve (two-person for production),
 * reject, and apply. All actions audited by the service.
 */
@ApiTags('admin-payment-promotion')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('admin/payments/promotion')
export class PromotionController {
  constructor(private readonly promotion: PromotionService) {}

  @Get('report')
  @ApiOperation({ summary: 'Preview the promotion validation report (admin).' })
  report(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('provider') provider: string,
  ) {
    return this.promotion.buildReport(
      from.toUpperCase() as PaymentEnvName,
      to.toUpperCase() as PaymentEnvName,
      provider,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List promotion requests (admin).' })
  list(@Query('to') to?: string, @Query('status') status?: string) {
    return this.promotion.list(to ? (to.toUpperCase() as PaymentEnvName) : undefined, status);
  }

  @Post()
  @ApiOperation({ summary: 'Request an environment promotion (admin).' })
  create(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Body(new ZodValidationPipe(createSchema))
    body: { fromEnv: PaymentEnvName; toEnv: PaymentEnvName; provider: string },
  ) {
    return this.promotion.createRequest(body.fromEnv, body.toEnv, body.provider, {
      userId: user.id,
      ip,
    });
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a promotion (two-person for production) (admin).' })
  approve(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ note: z.string().optional() }))) body: { note?: string },
  ) {
    return this.promotion.approve(id, { userId: user.id, ip }, body.note);
  }

  @Post(':id/reject')
  reject(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ reason: z.string().min(1) }))) body: { reason: string },
  ) {
    return this.promotion.reject(id, { userId: user.id, ip }, body.reason);
  }

  @Post(':id/apply')
  @ApiOperation({ summary: 'Apply an approved promotion to the target env (admin).' })
  apply(@CurrentUser() user: RequestUser, @Ip() ip: string, @Param('id') id: string) {
    return this.promotion.apply(id, { userId: user.id, ip });
  }
}
