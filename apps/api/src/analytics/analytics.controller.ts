import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { AnalyticsService } from './analytics.service';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const organizerQuery = z.object({ organizationId: z.string().min(1) });

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('organizer')
  @ApiOperation({
    summary:
      'Whole-organization organizer analytics (single aggregate round; no per-event fan-out).',
  })
  organizer(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(organizerQuery)) q: { organizationId: string },
  ) {
    return this.analytics.organizer(user, q.organizationId);
  }

  @Get('venue/:venueId')
  @ApiOperation({ summary: 'Venue utilization, occupancy, and revenue.' })
  venue(@CurrentUser() user: RequestUser, @Param('venueId') venueId: string) {
    return this.analytics.venue(user, venueId);
  }

  @Get('customer')
  @ApiOperation({ summary: "The signed-in customer's booking analytics." })
  customer(@CurrentUser() user: RequestUser) {
    return this.analytics.customer(user);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.FINANCE_READ)
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('platform')
  @ApiOperation({ summary: 'Platform-wide analytics (GMV, retention, conversion funnel).' })
  platform() {
    return this.analytics.platform();
  }
}
