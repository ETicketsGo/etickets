import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@eticketsgo/shared-types';
import { createConnectAccountSchema, type CreateConnectAccountInput } from '@eticketsgo/validation';
import { OrganizerConnectService } from './organizer-connect.service';
import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

/**
 * Organizer self-service Stripe Connect onboarding. The service enforces the
 * per-organization tenant check (assertMember); this class-level guard limits the
 * surface to organizer roles + platform admins.
 */
@ApiTags('organizer-payments')
@ApiBearerAuth()
@Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
@Controller('organizers/:organizerId/payments')
export class OrganizerConnectController {
  constructor(private readonly connect: OrganizerConnectService) {}

  @Post('stripe/account')
  @ApiOperation({ summary: "Create or return the organizer's Stripe connected account." })
  createAccount(
    @CurrentUser() user: RequestUser,
    @Param('organizerId') organizerId: string,
    @Body(new ZodValidationPipe(createConnectAccountSchema)) body: CreateConnectAccountInput,
  ) {
    return this.connect.createOrGetAccount(user, organizerId, body);
  }

  @Post('stripe/onboarding-link')
  @ApiOperation({ summary: 'Generate a secure Stripe hosted onboarding link.' })
  onboardingLink(@CurrentUser() user: RequestUser, @Param('organizerId') organizerId: string) {
    return this.connect.createOnboardingLink(user, organizerId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Safe onboarding/payout status (no sensitive Stripe data).' })
  status(@CurrentUser() user: RequestUser, @Param('organizerId') organizerId: string) {
    return this.connect.getStatus(user, organizerId);
  }

  @Post('stripe/dashboard-link')
  @ApiOperation({ summary: 'Generate a Stripe Express dashboard login link.' })
  dashboardLink(@CurrentUser() user: RequestUser, @Param('organizerId') organizerId: string) {
    return this.connect.createDashboardLink(user, organizerId);
  }
}
