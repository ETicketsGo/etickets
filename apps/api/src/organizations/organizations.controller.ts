import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
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
import { ORG_REGISTRATION_THROTTLE } from './organization-limits';
import { RequiresAdmin, CurrentUser, Public, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ORG_COVER_MAX_BYTES,
  ORG_LOGO_MAX_BYTES,
  OrganizationImagesService,
} from './organization-images.service';
import type { UploadedImageFile } from '../events/event-image.service';

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly orgs: OrganizationsService,
    private readonly logos: OrganizationImagesService,
  ) {}

  /*
    A handful an hour from one source. The per-account cap stops one account flooding the
    approval queue slowly; this stops a burst. Accounts themselves are throttled at sign-up.
  */
  @Throttle(ORG_REGISTRATION_THROTTLE)
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

  /*
    The organization's profile picture. One file per request, multipart, replacing whatever
    was there. The size cap is enforced where multer reads the stream, so an oversized
    upload is refused before it is buffered in full.
  */
  @Post(':id/logo')
  @ApiOperation({ summary: 'Upload the organization profile picture (JPG, PNG or WebP, 1 MB).' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ORG_LOGO_MAX_BYTES, files: 1 } }))
  uploadLogo(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @UploadedFile() file?: UploadedImageFile,
  ) {
    return this.logos.upload(user, id, 'LOGO', file);
  }

  @Delete(':id/logo')
  @ApiOperation({ summary: 'Remove the organization profile picture.' })
  removeLogo(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.logos.remove(user, id, 'LOGO');
  }

  /* The cover banner. Same rules as the picture above, with a larger cap: it is a wide
     image across the top of a profile rather than a small square. */
  @Post(':id/cover')
  @ApiOperation({ summary: 'Upload the organization cover image (JPG, PNG or WebP, 3 MB).' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ORG_COVER_MAX_BYTES, files: 1 } }))
  uploadCover(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @UploadedFile() file?: UploadedImageFile,
  ) {
    return this.logos.upload(user, id, 'COVER', file);
  }

  @Delete(':id/cover')
  @ApiOperation({ summary: 'Remove the organization cover image.' })
  removeCover(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.logos.remove(user, id, 'COVER');
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

  /**
   * What a reviewer needs before deciding, in one call.
   *
   * Sits beside the decision rather than inside the list, because the list is a queue and
   * this is the file: assembling it for fifty rows nobody will open would make the queue
   * slow in order to answer a question nobody asked yet.
   */
  @Get(':id/review-signals')
  @ApiOperation({
    summary:
      'Registration signals for review (admin): declared legal identity, owner account age ' +
      'and email domain, other organizations by the same owner, and name collisions.',
  })
  reviewSignals(@Param('id') id: string) {
    return this.orgs.reviewSignals(id);
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

  @Get(':id/legal-identity')
  @ApiOperation({ summary: "An organization's legal + tax identity, read by an admin." })
  adminLegalIdentity(@Param('id') id: string) {
    return this.orgs.adminLegalIdentityStatus(id);
  }

  @Patch(':id/legal-identity')
  @ApiOperation({
    summary: "Record an organization's legal + tax identity on their behalf (admin).",
  })
  adminUpdateLegalIdentity(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateOrganizationLegalIdentitySchema))
    body: UpdateOrganizationLegalIdentityInput,
  ) {
    return this.orgs.adminUpdateLegalIdentity(admin, id, body);
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

/**
 * The organization's profile picture, for anybody's browser.
 *
 * Public and unthrottled for the same reason an event poster is: it is an `<img>` on pages
 * that render many of them, and a throttle here shows customers broken images. The headers
 * are the poster's headers - cross-origin so the console and storefront can render it, a
 * locked-down CSP and `nosniff` so the bytes can only ever be treated as an image, and an
 * ETag so a repeat visit is a 304.
 */
@ApiTags('public')
@Controller('public/organizers')
export class PublicOrganizerLogoController {
  constructor(private readonly logos: OrganizationImagesService) {}

  @Public()
  @SkipThrottle()
  @Get(':id/logo')
  @ApiOperation({ summary: "An organization's profile picture." })
  async logo(
    @Param('id') id: string,
    @Query('v') version: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(res, await this.logos.read(id, 'LOGO'), version, ifNoneMatch);
  }

  @Public()
  @SkipThrottle()
  @Get(':id/cover')
  @ApiOperation({ summary: "An organization's cover image." })
  async cover(
    @Param('id') id: string,
    @Query('v') version: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    return this.send(res, await this.logos.read(id, 'COVER'), version, ifNoneMatch);
  }

  private send(
    res: Response,
    image: { bytes: Uint8Array; contentType: string; sha256: string } | null,
    version: string | undefined,
    ifNoneMatch: string | undefined,
  ): void {
    if (!image) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'This organizer has no such image.' });
      return;
    }
    const current = image.sha256.slice(0, 16);
    const etag = `"${current}"`;
    res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      version === current ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }
    const bytes = Buffer.from(image.bytes);
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.status(200).end(bytes);
  }
}
