import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, OrganizationStatus, Role } from '@eticketsgo/shared-types';
import {
  acceptInvitationSchema,
  createOrganizationSchema,
  inviteMemberSchema,
  paginationSchema,
  reviewDecisionSchema,
  updateOrganizationLegalIdentitySchema,
  updateOrganizationProfileSchema,
  type AcceptInvitationInput,
  type CreateOrganizationInput,
  type InviteMemberInput,
  type ReviewDecisionInput,
  type UpdateOrganizationLegalIdentityInput,
  type UpdateOrganizationProfileInput,
} from '@eticketsgo/validation';
import { OrganizationsService } from './organizations.service';
import { RequiresAdmin, CurrentUser, Public, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post()
  @ApiOperation({ summary: 'Register a new organization (organizer onboarding).' })
  register(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
  ) {
    return this.orgs.register(user, body);
  }

  @Get()
  @ApiOperation({ summary: 'List organizations the current user belongs to.' })
  listMine(@CurrentUser() user: RequestUser) {
    return this.orgs.listMine(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an organization the user can access.' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orgs.get(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update the public organizer profile.' })
  updateProfile(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateOrganizationProfileSchema))
    body: UpdateOrganizationProfileInput,
  ) {
    return this.orgs.updateProfile(user, id, body);
  }

  @Get(':id/legal-identity')
  @ApiOperation({ summary: "The seller's legal + tax identity, and what is still missing." })
  legalIdentity(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orgs.legalIdentityStatus(user, id);
  }

  @Patch(':id/legal-identity')
  @Roles(Role.ORGANIZER_OWNER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: "Update the seller's legal + tax identity (owner only)." })
  updateLegalIdentity(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateOrganizationLegalIdentitySchema))
    body: UpdateOrganizationLegalIdentityInput,
  ) {
    return this.orgs.updateLegalIdentity(user, id, body);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List the organization team.' })
  members(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orgs.listMembers(user, id);
  }

  @Patch(':id/cash-payments')
  @ApiOperation({ summary: 'Turn cash-at-the-venue on or off. Owner only.' })
  setCashPayments(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ enabled: z.boolean() })))
    body: { enabled: boolean },
  ) {
    return this.orgs.setCashPayments(user, id, body.enabled);
  }

  @Get(':id/cash-bookings')
  @ApiOperation({ summary: 'Cash bookings awaiting collection at the counter.' })
  cashBookings(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(z.object({ includeCollected: z.coerce.boolean().optional() })))
    q: { includeCollected?: boolean },
  ) {
    return this.orgs.cashBookings(user, id, q.includeCollected ?? false);
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Invite a team member.' })
  invite(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberInput,
  ) {
    return this.orgs.inviteMember(user, id, body);
  }

  @Post(':id/members/:memberId/resend-invite')
  @ApiOperation({
    summary: 'Issue a fresh invitation link for a member who has not accepted yet.',
  })
  resendInvite(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    return this.orgs.resendInvitation(user, id, memberId);
  }
}

/**
 * Accepting an invitation, without being signed in.
 *
 * Its own controller because the whole point is that the invitee may have NO ACCOUNT — the
 * organizations controller carries `@ApiBearerAuth()` and sits behind the global auth guard,
 * and an invite path that requires a session is a door that only opens from inside.
 *
 * The token is the credential here. It is single-use, hashed at rest, and expires; and an
 * unknown token is answered exactly like a spent one, so the endpoint cannot be used to
 * discover which invitations exist.
 */
@ApiTags('invitations')
@Controller('public/invitations')
export class PublicInvitationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'What this invitation is for, so the page can be rendered.' })
  describe(@Param('token') token: string) {
    return this.orgs.describeInvitation(token);
  }

  @Public()
  @Post(':token/accept')
  @ApiOperation({ summary: 'Accept an invitation. The only route from INVITED to ACTIVE.' })
  accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: AcceptInvitationInput,
  ) {
    return this.orgs.acceptInvitation(token, body);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.ORGANIZER_REVIEW)
@Controller('admin/organizers')
export class AdminOrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  @ApiOperation({ summary: 'List organizations for review (admin).' })
  list(
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({ status: z.nativeEnum(OrganizationStatus).optional() }),
      ),
    )
    q: {
      page: number;
      pageSize: number;
      status?: OrganizationStatus;
    },
  ) {
    return this.orgs.adminList(q.status, q.page, q.pageSize);
  }

  @Post(':id/review')
  @ApiOperation({ summary: 'Approve or reject an organization (admin).' })
  review(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reviewDecisionSchema)) body: ReviewDecisionInput,
  ) {
    return this.orgs.review(admin, id, body);
  }

  @Patch(':id/auto-approve')
  @ApiOperation({
    summary: 'Let a trusted organizer publish events without review, or stop them (admin).',
  })
  setAutoApprove(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ enabled: z.boolean() })))
    body: { enabled: boolean },
  ) {
    return this.orgs.setAutoApprove(admin, id, body.enabled);
  }
}
