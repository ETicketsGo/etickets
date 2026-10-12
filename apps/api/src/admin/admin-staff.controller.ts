import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, ALL_ADMIN_PERMISSIONS, Role } from '@eticketsgo/shared-types';
import { AdminStaffService } from './admin-staff.service';
import {
  CurrentUser,
  RequiresAdmin,
  RequiresRecentMfa,
  Roles,
  type RequestUser,
} from '../common/decorators';
import { MfaService } from '../auth/mfa/mfa.service';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const permissionsBody = z.object({
  permissions: z.array(z.enum(ALL_ADMIN_PERMISSIONS as [string, ...string[]])).max(50),
  note: z.string().trim().max(200).optional(),
});

/** Inviting somebody who has no account yet: an address, and what they may do. */
const inviteStaffBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  permissions: z.array(z.enum(ALL_ADMIN_PERMISSIONS as [string, ...string[]])).max(50),
});

/**
 * Managing who works in the back office.
 *
 * Every route needs ADMIN_MANAGE, which in practice means a super admin: an account that
 * can grant itself a capability effectively holds all of them, so this is the one duty that
 * cannot be delegated casually.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.ADMIN_MANAGE)
@Controller('admin/staff')
export class AdminStaffController {
  constructor(
    private readonly staff: AdminStaffService,
    private readonly mfa: MfaService,
  ) {}

  @Get('catalogue')
  @ApiOperation({ summary: 'Every assignable permission, plus the ready-made bundles.' })
  catalogue() {
    return this.staff.catalogue();
  }

  @Get()
  @ApiOperation({ summary: 'Back-office accounts and what each of them may do.' })
  list() {
    return this.staff.list();
  }

  @Put(':userId/permissions')
  @RequiresRecentMfa()
  @ApiOperation({ summary: "Replace an account's permissions with exactly this set." })
  setPermissions(
    @CurrentUser() actor: RequestUser,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(permissionsBody)) body: z.infer<typeof permissionsBody>,
  ) {
    return this.staff.setPermissions(
      actor,
      userId,
      body.permissions as AdminPermission[],
      body.note,
    );
  }

  @Put(':userId/admin-role')
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Make an existing account a back-office account.' })
  grant(
    @CurrentUser() actor: RequestUser,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(permissionsBody)) body: z.infer<typeof permissionsBody>,
  ) {
    return this.staff.grantAdminRole(actor, userId, body.permissions as AdminPermission[]);
  }

  @Post('invite')
  @RequiresRecentMfa()
  @ApiOperation({
    summary: 'Invite somebody who has no account yet, and grant them back-office duties.',
  })
  invite(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(inviteStaffBody)) body: z.infer<typeof inviteStaffBody>,
  ) {
    return this.staff.inviteStaff(actor, body.email, body.permissions as AdminPermission[]);
  }

  @Post(':userId/mfa/reset')
  @RequiresRecentMfa()
  @ApiOperation({
    summary: "Remove another account's authenticator so it must enroll again. Super admin only.",
  })
  async resetMfa(
    @CurrentUser() actor: RequestUser,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.mfa.resetForUser(actor, userId, { ip: req.ip });
    return { success: true };
  }

  @Delete(':userId/admin-role')
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Remove back-office access and every permission with it.' })
  revoke(@CurrentUser() actor: RequestUser, @Param('userId') userId: string) {
    return this.staff.revokeAdminRole(actor, userId);
  }
}
