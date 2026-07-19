import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { OrganizationStatus, Role } from '@eticketsgo/shared-types';
import {
  createOrganizationSchema,
  inviteMemberSchema,
  paginationSchema,
  reviewDecisionSchema,
  updateOrganizationProfileSchema,
  type CreateOrganizationInput,
  type InviteMemberInput,
  type ReviewDecisionInput,
  type UpdateOrganizationProfileInput,
} from '@eticketsgo/validation';
import { OrganizationsService } from './organizations.service';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
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

  @Get(':id/members')
  @ApiOperation({ summary: 'List the organization team.' })
  members(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orgs.listMembers(user, id);
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
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
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
}
