import { Body, Controller, Get, Ip, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PaymentOutageService } from './payment-outage.service';

const suspendSchema = z.object({ suspended: z.boolean() });

/**
 * Provider outage operations console (ADR-030). ADMIN/SUPER_ADMIN only. Suspend or
 * resume routes/countries/providers, activate or roll back failover, and toggle
 * maintenance mode. Every action is audited by the service.
 */
@ApiTags('admin-payment-outage')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PAYMENT_ADMIN)
@Controller('admin/payments/outage')
export class PaymentOutageController {
  constructor(private readonly outage: PaymentOutageService) {}

  @Get('status')
  @ApiOperation({ summary: 'Current outage posture (circuits, suspensions) (admin).' })
  status() {
    return this.outage.status();
  }

  @Post('route/:id/suspend')
  route(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(suspendSchema)) body: { suspended: boolean },
  ) {
    return this.outage.setRouteSuspended(id, body.suspended, { userId: user.id, ip });
  }

  @Post('country/:country/suspend')
  country(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('country') country: string,
    @Body(new ZodValidationPipe(suspendSchema)) body: { suspended: boolean },
  ) {
    return this.outage.setCountrySuspended(country, body.suspended, { userId: user.id, ip });
  }

  @Post('provider/:provider/suspend')
  provider(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(suspendSchema)) body: { suspended: boolean },
  ) {
    return this.outage.setProviderSuspended(provider, body.suspended, { userId: user.id, ip });
  }

  @Post('provider/:provider/failover')
  @ApiOperation({ summary: 'Activate or roll back failover for a provider (admin).' })
  failover(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(z.object({ activate: z.boolean() }))) body: { activate: boolean },
  ) {
    const actor = { userId: user.id, ip };
    return body.activate
      ? this.outage.activateFailover(provider, actor)
      : this.outage.rollbackFailover(provider, actor);
  }

  @Post('maintenance')
  @ApiOperation({ summary: 'Toggle maintenance mode (admin).' })
  maintenance(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Body(new ZodValidationPipe(z.object({ enabled: z.boolean(), message: z.string().optional() })))
    body: { enabled: boolean; message?: string },
  ) {
    return this.outage.setMaintenance(body.enabled, body.message, { userId: user.id, ip });
  }
}
