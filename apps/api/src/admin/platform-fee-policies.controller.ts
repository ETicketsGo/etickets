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
  kind: z.enum(['WAIVE', 'FIXED', 'PERCENT', 'COMBINED']),
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
  // Paid tickets in the sample basket; only a COMBINED fee (fixed part per ticket) reads it.
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
  status: z.enum(['ACTIVE', 'SCHEDULED', 'EXPIRED', 'EXHAUSTED', 'INACTIVE']).optional(),
  organizationId: z.string().trim().min(1).max(64).optional(),
  eventId: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
type ListQuery = z.infer<typeof listSchema>;

/**
 * Platform fee overrides and waivers for one organizer or one event.
 *
 * Reads need PLATFORM_CONFIG_READ (finance can explain why an order paid no booking fee);
 * writes need PLATFORM_CONFIG and a fresh second-factor check, like every other rule that
 * changes what buyers pay. Each handler names its own capability: a class-level one would be
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
  detail(@Param('id') id: string) {
    return this.policies.detail(id);
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

  @Post(':id/deactivate')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Deactivate a platform fee policy (admin).' })
  deactivatePlatformFeePolicy(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(deactivateSchema)) body: DeactivateBody,
  ) {
    return this.policies.deactivate(user.id, id, body);
  }
}
