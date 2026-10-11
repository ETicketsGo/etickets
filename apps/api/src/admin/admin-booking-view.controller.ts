import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, Roles, type RequestUser } from '../common/decorators';
import { BookingsService } from '../bookings/bookings.service';
import { OrgAccessService } from '../tenancy/org-access.service';

/**
 * A customer's booking, read by platform staff.
 *
 * `GET /bookings/:id` is the buyer's route and answers nobody else. Staff used to reach it by
 * role alone, with no capability and no record; the admin console now reads here instead. The
 * class guard is `BOOKING_READ` (the support desk's floor), and `assertPlatformCapability` writes
 * the audit row: who read which booking, under which request, allowed or refused.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.BOOKING_READ)
@Controller('admin/bookings')
export class AdminBookingViewController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly access: OrgAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: "One customer's booking (admin, BOOKING_READ, audited)." })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.bookings.getForStaff(id, (b) =>
      this.access.assertPlatformCapability(user, {
        permission: AdminPermission.BOOKING_READ,
        operation: 'booking.admin-read',
        organizationId: b.organizationId,
        entityType: 'Booking',
        entityId: b.id,
        message: 'Forbidden.',
      }),
    );
  }
}
