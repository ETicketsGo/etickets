import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@eticketsgo/shared-types';
import { razorpayLinkAccountSchema, type RazorpayLinkAccountInput } from '@eticketsgo/validation';
import { RazorpayConnectService } from './razorpay-connect.service';
import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

/**
 * Organizer self-service Razorpay Route (India) payout account. Linked Account creation +
 * KYC is completed in the Razorpay dashboard; the organizer links the resulting id here.
 */
@ApiTags('organizer-payments')
@ApiBearerAuth()
@Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
@Controller('organizers/:organizerId/payments/razorpay')
export class RazorpayConnectController {
  constructor(private readonly connect: RazorpayConnectService) {}

  @Post('account')
  @ApiOperation({ summary: 'Link a Razorpay Linked Account (dashboard-created) for payouts.' })
  link(
    @CurrentUser() user: RequestUser,
    @Param('organizerId') organizerId: string,
    @Body(new ZodValidationPipe(razorpayLinkAccountSchema)) body: RazorpayLinkAccountInput,
  ) {
    return this.connect.linkAccount(user, organizerId, body.linkedAccountId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Razorpay payout account status (route/KYC readiness).' })
  status(@CurrentUser() user: RequestUser, @Param('organizerId') organizerId: string) {
    return this.connect.getStatus(user, organizerId);
  }
}
