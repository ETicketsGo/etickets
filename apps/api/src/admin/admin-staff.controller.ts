import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, ALL_ADMIN_PERMISSIONS, Role } from '@eticketsgo/shared-types';
import { AdminStaffService } from './admin-staff.service';
import { CurrentUser, RequiresAdmin, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const permissionsBody = z.object({
  permissions: z.array(z.enum(ALL_ADMIN_PERMISSIONS as [string, ...string[]])).max(50),
  note: z.string().trim().max(200).optional(),
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
  constructor(private readonly staff: AdminStaffService) {}

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
  @ApiOperation({ summary: 'Make an existing account a back-office account.' })
  grant(
    @CurrentUser() actor: RequestUser,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(permissionsBody)) body: z.infer<typeof permissionsBody>,
  ) {
    return this.staff.grantAdminRole(actor, userId, body.permissions as AdminPermission[]);
  }

  @Delete(':userId/admin-role')
  @ApiOperation({ summary: 'Remove back-office access and every permission with it.' })
  revoke(@CurrentUser() actor: RequestUser, @Param('userId') userId: string) {
    return this.staff.revokeAdminRole(actor, userId);
  }
}
