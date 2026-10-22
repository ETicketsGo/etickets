import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { AdminUsersService } from './admin-users.service';
import {
  CurrentUser,
  RequiresAdmin,
  RequiresRecentMfa,
  Roles,
  type RequestUser,
} from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { requestClientIp } from '../common/client-ip';

const suspendBody = z.object({ reason: z.string().trim().min(1).max(500) });
const optionalReasonBody = z
  .object({ reason: z.string().trim().max(500).optional() })
  .optional()
  .default({});

/**
 * Stopping an account, starting it again, and ending its sessions.
 *
 * USER_SUSPEND on every route, and a fresh second-factor check: locking somebody out is as
 * consequential as changing what they may do, and a console left open on an unlocked machine
 * must not be able to do it. The rules about WHOSE account (not your own, a super admin only
 * by a super admin) are the service's, so they hold for any future caller too.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.USER_SUSPEND)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Post(':id/suspend')
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Suspend an account and end every session it has (admin).' })
  suspend(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(suspendBody)) body: z.infer<typeof suspendBody>,
    @Req() req: Request,
  ) {
    return this.users.suspend(actor, id, body.reason, { ip: requestClientIp(req) });
  }

  @Post(':id/reinstate')
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Reinstate a suspended account (admin).' })
  reinstate(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(optionalReasonBody)) body: { reason?: string },
    @Req() req: Request,
  ) {
    return this.users.reinstate(actor, id, body?.reason, { ip: requestClientIp(req) });
  }

  @Post(':id/revoke-sessions')
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Sign an account out on every device (admin).' })
  revokeSessions(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(optionalReasonBody)) body: { reason?: string },
    @Req() req: Request,
  ) {
    return this.users.revokeSessions(actor, id, body?.reason, { ip: requestClientIp(req) });
  }
}
