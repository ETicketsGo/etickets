import { Body, Controller, Get, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PAYMENT_ENVS } from '../configuration/payment-environment';
import type { OnboardingStatus } from './merchant-onboarding.checklist';
import {
  MerchantOnboardingService,
  type CreateOnboardingInput,
  type OnboardingPatch,
} from './merchant-onboarding.service';
import { SandboxCertificationService } from '../certification/sandbox-certification.service';

const createSchema = z.object({
  env: z.enum(PAYMENT_ENVS),
  organizationId: z.string().optional(),
  country: z.string().min(2),
  legalBusinessName: z.string().min(1),
  displayName: z.string().min(1),
  merchantType: z.string().optional(),
  settlementCurrency: z.string().min(3),
  provider: z.enum(['stripe', 'razorpay', 'paypal', 'square']),
  mode: z.enum(['TEST', 'LIVE']).optional(),
});

const patchSchema = z
  .object({
    country: z.string().min(2).optional(),
    legalBusinessName: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    merchantType: z.string().optional(),
    settlementCurrency: z.string().min(3).optional(),
    provider: z.enum(['stripe', 'razorpay', 'paypal', 'square']).optional(),
    mode: z.enum(['TEST', 'LIVE']).optional(),
    accountIdentifier: z.string().nullable().optional(),
    secretKeyRef: z.string().nullable().optional(),
    webhookSecretRef: z.string().nullable().optional(),
    publicKey: z.string().nullable().optional(),
    settlementSchedule: z.string().optional(),
    payoutDestinationRef: z.string().nullable().optional(),
  })
  .strict();

const reasonSchema = z.object({ reason: z.string().min(1) });

/**
 * Admin merchant-onboarding console (ADR-025). ADMIN/SUPER_ADMIN only. Drives the
 * wizard: create/edit, accept terms, set webhook + verification status, test
 * connection, transition, activate, suspend, reject — all audited by the service.
 */
@ApiTags('admin-merchant-onboarding')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PAYMENT_ADMIN)
@Controller('admin/payments/onboarding')
export class MerchantOnboardingController {
  constructor(
    private readonly onboarding: MerchantOnboardingService,
    private readonly certification: SandboxCertificationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List merchant onboarding records (admin).' })
  list(@Query('env') env?: string, @Query('status') status?: string) {
    return this.onboarding.list(
      env ? (env.toUpperCase() as never) : undefined,
      status ? (status as OnboardingStatus) : undefined,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Onboarding record + checklist (admin).' })
  detail(@Param('id') id: string) {
    return this.onboarding.detail(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a merchant onboarding record (admin).' })
  create(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Body(new ZodValidationPipe(createSchema)) body: CreateOnboardingInput,
  ) {
    return this.onboarding.create(body, { userId: user.id, ip });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a merchant onboarding record (admin).' })
  update(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(patchSchema)) patch: OnboardingPatch,
  ) {
    return this.onboarding.update(id, patch, { userId: user.id, ip });
  }

  @Post(':id/accept-terms')
  acceptTerms(@CurrentUser() user: RequestUser, @Ip() ip: string, @Param('id') id: string) {
    return this.onboarding.acceptTerms(id, { userId: user.id, ip });
  }

  @Post(':id/webhook-status')
  setWebhookStatus(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(
      new ZodValidationPipe(
        z.object({ status: z.enum(['NOT_CONFIGURED', 'CONFIGURED', 'VERIFIED']) }),
      ),
    )
    body: { status: string },
  ) {
    return this.onboarding.setWebhookStatus(id, body.status, { userId: user.id, ip });
  }

  @Post(':id/verification')
  setVerification(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(
      new ZodValidationPipe(
        z.object({ status: z.enum(['UNVERIFIED', 'IN_REVIEW', 'VERIFIED', 'FAILED']) }),
      ),
    )
    body: { status: string },
  ) {
    return this.onboarding.setVerification(id, body.status, { userId: user.id, ip });
  }

  @Post(':id/test-connection')
  @ApiOperation({ summary: "Health-check the merchant's own credentials (admin)." })
  testConnection(@CurrentUser() user: RequestUser, @Ip() ip: string, @Param('id') id: string) {
    return this.onboarding.testConnection(id, { userId: user.id, ip });
  }

  @Post(':id/certify')
  @ApiOperation({ summary: 'Run sandbox certification for this merchant (admin).' })
  certify(@CurrentUser() user: RequestUser, @Ip() ip: string, @Param('id') id: string) {
    return this.certification.certifyOnboarding(id, { userId: user.id, ip });
  }

  @Get(':id/certifications')
  @ApiOperation({ summary: 'List certification runs for this merchant (admin).' })
  certifications(@Param('id') id: string) {
    return this.certification.list(id);
  }

  @Post(':id/transition')
  transition(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(
      new ZodValidationPipe(
        z.object({
          to: z.enum([
            'PENDING_CONFIGURATION',
            'PENDING_VERIFICATION',
            'TESTING',
            'READY_FOR_LIVE',
          ]),
        }),
      ),
    )
    body: { to: OnboardingStatus },
  ) {
    return this.onboarding.transition(id, body.to, { userId: user.id, ip });
  }

  @Post(':id/activate')
  @ApiOperation({ summary: 'Activate a ready merchant (admin).' })
  activate(@CurrentUser() user: RequestUser, @Ip() ip: string, @Param('id') id: string) {
    return this.onboarding.activate(id, { userId: user.id, ip });
  }

  @Post(':id/suspend')
  suspend(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ) {
    return this.onboarding.suspend(id, body.reason, { userId: user.id, ip });
  }

  @Post(':id/reject')
  reject(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ) {
    return this.onboarding.reject(id, body.reason, { userId: user.id, ip });
  }
}
