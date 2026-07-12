import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { CheckinsService } from './checkins.service';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const scanSchema = z.object({
  token: z.string().min(1),
  expectedSessionId: z.string().cuid().optional(),
  deviceInfo: z.string().max(200).optional(),
});
const reverseSchema = z.object({ ticketId: z.string().cuid() });

@ApiTags('checkins')
@ApiBearerAuth()
@Roles(
  Role.CHECKIN_STAFF,
  Role.ORGANIZER_MANAGER,
  Role.ORGANIZER_OWNER,
  Role.ADMIN,
  Role.SUPER_ADMIN,
)
@Controller('checkins')
export class CheckinsController {
  constructor(private readonly checkins: CheckinsService) {}

  @Post()
  @ApiOperation({ summary: 'Scan and check in a ticket by QR token.' })
  scan(
    @CurrentUser() staff: RequestUser,
    @Body(new ZodValidationPipe(scanSchema)) body: z.infer<typeof scanSchema>,
  ) {
    return this.checkins.scan(staff, body.token, {
      expectedSessionId: body.expectedSessionId,
      deviceInfo: body.deviceInfo,
    });
  }

  @Post('reverse')
  @Roles(Role.ORGANIZER_MANAGER, Role.ORGANIZER_OWNER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Reverse a check-in (authorized roles only).' })
  reverse(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(reverseSchema)) body: { ticketId: string },
  ) {
    return this.checkins.reverse(user, body.ticketId);
  }
}
