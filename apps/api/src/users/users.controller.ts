import { Body, Controller, Delete, Get, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { UsersService } from './users.service';
import { AccountDeletionService } from './account-deletion.service';
import { CurrentUser, RequiresAdmin, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const updateProfileSchema = z.object({ fullName: z.string().trim().min(2).max(120) });

/**
 * Optional coarse reason for leaving. Bounded here and reduced to a known category by
 * the service — free text typed by a user should not survive in an audit table that
 * outlives the deletion they just requested.
 */
const deleteAccountSchema = z
  .object({ reason: z.string().trim().max(200).optional() })
  .optional()
  .default({});

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly accountDeletion: AccountDeletionService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the current user profile.' })
  me(@CurrentUser('id') userId: string) {
    return this.users.profile(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the current user profile.' })
  updateMe(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: { fullName: string },
  ) {
    return this.users.updateProfile(userId, body.fullName);
  }

  /**
   * Delete the caller's account.
   *
   * Required by both app stores for any app that lets you create an account. Idempotent:
   * a retry after a dropped response returns the same success rather than a 404, because
   * a mobile client must never be told a completed deletion failed.
   *
   * Re-authentication is NOT required here. The mobile flow gates it behind an explicit
   * typed confirmation, and the API has no re-auth primitive short of asking for the
   * password again — which for an OAuth-less, password-only account adds a step without
   * adding assurance, since the bearer token already proves the same secret.
   */
  @Delete('me')
  @ApiOperation({ summary: 'Delete the current user account (irreversible).' })
  @ApiResponse({ status: 200, description: 'Account deleted, or already deleted.' })
  @ApiResponse({ status: 409, description: 'ACCOUNT_DELETION_BLOCKED — sole organization owner.' })
  deleteMe(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(deleteAccountSchema)) body: { reason?: string },
    @Req() req: Request,
  ) {
    return this.accountDeletion.deleteMe(userId, {
      reason: body?.reason,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
  }

  /*
    Every account's name, email, roles and status — the platform's whole customer directory.

    It carried `@Roles(ADMIN)` and no capability, and the permission guard lets a route that
    declares no capability through. So an admin account granted nothing at all, or only
    moderation, could page through every customer's email address — the "every admin can do
    everything" behaviour the capability model replaced, surviving in the one admin route that
    does not live under `/admin`. BOOKING_READ is the support desk's floor for reading customer
    records, which is what this is.
  */
  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequiresAdmin(AdminPermission.BOOKING_READ)
  @ApiOperation({ summary: 'List users (admin).' })
  list(
    @Query(new ZodValidationPipe(paginationSchema.extend({ q: z.string().optional() })))
    q: {
      page: number;
      pageSize: number;
      q?: string;
    },
  ) {
    return this.users.list(q.page, q.pageSize, q.q);
  }
}
