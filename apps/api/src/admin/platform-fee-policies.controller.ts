import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, RequiresRecentMfa, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PlatformFeePoliciesService } from './platform-fee-policies.service';

/*
  Amounts are integer MINOR units; a percentage is BASIS POINTS (250 is 2.5%). Whether the
  combination makes sense for the kind is checked by the service (`normaliseTerms`), so the
  preview and the create refuse the same things in the same words.
*/
const termsFields = {
  kind: z.enum(['WAIVE', 'FIXED', 'PERCENT', 'COMBINED', 'FIXED_PER_TICKET']),
  feeMinor: z.number().int().min(0).max(100_000_000).nullable().optional(),
  percentBps: z
    .number()
    .int()
    .min(0)
    .max(10_000, 'Basis points: 500 is 5%. A booking fee cannot exceed 100% (10000).')
    .nullable()
    .optional(),
  minFeeMinor: z.number().int().min(0).max(100_000_000).nullable().optional(),
  maxFeeMinor: z.number().int().min(0).max(100_000_000).nullable().optional(),
};
const targetFields = {
  scope: z.enum(['EVENT', 'ORGANIZATION']),
  eventId: z.string().trim().min(1).max(64).nullable().optional(),
  organizationId: z.string().trim().min(1).max(64).nullable().optional(),
};

const createSchema = z.object({
  ...targetFields,
  ...termsFields,
  currency: z.string().trim().max(3).nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  maxOrders: z.number().int().min(1).max(10_000_000).nullable().optional(),
  reason: z.string().trim().min(10, 'Say why, in at least 10 characters.').max(500),
  approvalReference: z.string().trim().max(120).nullable().optional(),
});
type CreateBody = z.infer<typeof createSchema>;

const previewSchema = z.object({
  ...targetFields,
  ...termsFields,
  currency: z.string().trim().length(3),
  subtotalMinor: z.number().int().min(0).max(100_000_000),
  // Paid tickets in the sample basket; only a per-ticket fee reads it.
  ticketCount: z.number().int().min(0).max(1_000).optional(),
  feeMode: z.enum(['CUSTOMER_PAYS', 'ORGANIZER_PAYS', 'SHARED']).optional(),
});
type PreviewBody = z.infer<typeof previewSchema>;

const deactivateSchema = z.object({
  reason: z.string().trim().min(10, 'Say why, in at least 10 characters.').max(500),
  version: z.number().int().min(1),
});
type DeactivateBody = z.infer<typeof deactivateSchema>;

const listSchema = z.object({
  scope: z.enum(['EVENT', 'ORGANIZATION']).optional(),
  status: z
    .enum([
      'ACTIVE',
      'SCHEDULED',
      'EXPIRED',
      'EXHAUSTED',
      'INACTIVE',
      'PENDING_APPROVAL',
      'REJECTED',
      'WITHDRAWN',
    ])
    .optional(),
  organizationId: z.string().trim().min(1).max(64).optional(),
  eventId: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
type ListQuery = z.infer<typeof listSchema>;

const versionOnly = z.object({ version: z.number().int().min(1) });
type VersionBody = z.infer<typeof versionOnly>;
const approveSchema = versionOnly.extend({
  note: z.string().trim().max(500).nullable().optional(),
});
type ApproveBody = z.infer<typeof approveSchema>;
const rejectSchema = versionOnly.extend({
  note: z.string().trim().min(5, 'Say why, in at least 5 characters.').max(500),
});
type RejectBody = z.infer<typeof rejectSchema>;
const emergencySchema = versionOnly.extend({
  reason: z.string().trim().min(20, 'Say why, in at least 20 characters.').max(1000),
});
type EmergencyBody = z.infer<typeof emergencySchema>;
const impactSchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/**
 * Platform fee overrides and waivers for one organizer or one event.
 *
 * Reads need PLATFORM_CONFIG_READ (finance can explain why an order paid no booking fee);
 * proposing a change (create, ask to switch off, withdraw your own) needs PLATFORM_CONFIG;
 * deciding on one needs FEE_SCHEDULE_APPROVE, and the service refuses the person who proposed
 * it. Approving, and the one-person emergency switch-off (which needs BOTH), also need a fresh
 * second factor, like every other rule that changes what buyers pay. Each handler names its own capability: a class-level one would be
 * replaced, not added to, by a handler's (see AdminController).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
@Controller('admin/platform-fee-policies')
export class PlatformFeePoliciesController {
  constructor(private readonly policies: PlatformFeePoliciesService) {}

  @Get()
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({ summary: 'List platform fee policies (admin).' })
  list(@Query(new ZodValidationPipe(listSchema)) q: ListQuery) {
    return this.policies.list(q);
  }

  /** A read, though it is a POST: it takes a draft policy and changes nothing. */
  @Post('preview')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({ summary: 'Preview a fee policy on a sample basket (admin).' })
  preview(@Body(new ZodValidationPipe(previewSchema)) body: PreviewBody) {
    return this.policies.preview(body);
  }

  @Get(':id')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({ summary: 'One platform fee policy with its history (admin).' })
  detail(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.policies.detail(id, new Date(), user.id);
  }

  @Get(':id/impact')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({ summary: 'Estimated effect of the pending decision on recent orders (admin).' })
  impact(@Param('id') id: string, @Query(new ZodValidationPipe(impactSchema)) q: { days: number }) {
    return this.policies.impact(id, q.days);
  }

  @Post()
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Create a platform fee policy (admin).' })
  createPlatformFeePolicy(
    @CurrentUser() user: { id: string },
    @Body(new ZodValidationPipe(createSchema)) body: CreateBody,
  ) {
    return this.policies.create(user.id, body);
  }

  @Post(':id/approve')
  @RequiresAdmin(AdminPermission.FEE_SCHEDULE_APPROVE)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Approve a fee policy waiting for approval (second admin).' })
  approvePlatformFeePolicy(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approveSchema)) body: ApproveBody,
  ) {
    return this.policies.approve(user.id, id, body);
  }

  @Post(':id/reject')
  @RequiresAdmin(AdminPermission.FEE_SCHEDULE_APPROVE)
  @ApiOperation({ summary: 'Reject a fee policy waiting for approval (second admin).' })
  rejectPlatformFeePolicy(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: RejectBody,
  ) {
    return this.policies.reject(user.id, id, body);
  }

  @Post(':id/withdraw')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Withdraw your own fee policy before a decision (admin).' })
  withdrawPlatformFeePolicy(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(versionOnly)) body: VersionBody,
  ) {
    return this.policies.withdraw(user.id, id, body);
  }

  @Post(':id/deactivation/approve')
  @RequiresAdmin(AdminPermission.FEE_SCHEDULE_APPROVE)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Approve a request to switch a fee policy off (second admin).' })
  approvePlatformFeePolicyDeactivation(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approveSchema)) body: ApproveBody,
  ) {
    return this.policies.approveDeactivation(user.id, id, body);
  }

  @Post(':id/deactivation/reject')
  @RequiresAdmin(AdminPermission.FEE_SCHEDULE_APPROVE)
  @ApiOperation({ summary: 'Reject a request to switch a fee policy off (second admin).' })
  rejectPlatformFeePolicyDeactivation(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: RejectBody,
  ) {
    return this.policies.rejectDeactivation(user.id, id, body);
  }

  @Post(':id/deactivation/withdraw')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: 'Withdraw your own request to switch a fee policy off (admin).' })
  withdrawPlatformFeePolicyDeactivation(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(versionOnly)) body: VersionBody,
  ) {
    return this.policies.withdrawDeactivation(user.id, id, body);
  }

  /** Break glass: one person, both capabilities, a fresh second factor, a written reason. */
  @Post(':id/emergency-deactivate')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG, AdminPermission.FEE_SCHEDULE_APPROVE)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Switch a fee policy off now, alone (emergency, admin).' })
  emergencyDeactivatePlatformFeePolicy(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(emergencySchema)) body: EmergencyBody,
  ) {
    return this.policies.emergencyDeactivate(user.id, id, body);
  }

  @Post(':id/deactivate')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Ask to switch a platform fee policy off (needs a second admin).' })
  deactivatePlatformFeePolicy(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(deactivateSchema)) body: DeactivateBody,
  ) {
    return this.policies.deactivate(user.id, id, body);
  }
}
