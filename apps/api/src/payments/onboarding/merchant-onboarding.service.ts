import { HttpStatus, Injectable } from '@nestjs/common';
import type { MerchantOnboarding, PaymentEnv, PaymentProviderMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { PaymentProviderFactory } from '../provider/factory/payment-provider.factory';
import type { PaymentEnvName } from '../configuration/payment-environment';
import {
  canTransition,
  isActivationReady,
  isEditable,
  onboardingChecklist,
  type OnboardingStatus,
} from './merchant-onboarding.checklist';

interface Actor {
  userId?: string;
  ip?: string | null;
}

export interface CreateOnboardingInput {
  env: PaymentEnvName;
  organizationId?: string;
  country: string;
  legalBusinessName: string;
  displayName: string;
  merchantType?: string;
  settlementCurrency: string;
  provider: string;
  mode?: PaymentProviderMode;
}

export type OnboardingPatch = Partial<{
  country: string;
  legalBusinessName: string;
  displayName: string;
  merchantType: string;
  settlementCurrency: string;
  provider: string;
  mode: PaymentProviderMode;
  accountIdentifier: string | null;
  secretKeyRef: string | null;
  webhookSecretRef: string | null;
  publicKey: string | null;
  settlementSchedule: string;
  payoutDestinationRef: string | null;
}>;

/**
 * Merchant onboarding workflow (ADR-025). Drives a merchant/provider record from
 * DRAFT to ACTIVE per environment, enforcing legal state transitions and a
 * blocking checklist before activation. Stores only account IDs + secret
 * references — never bank credentials. Every change is audited.
 */
@Injectable()
export class MerchantOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly factory: PaymentProviderFactory,
  ) {}

  async create(input: CreateOnboardingInput, actor: Actor): Promise<MerchantOnboarding> {
    const row = await this.prisma.merchantOnboarding.create({
      data: {
        env: input.env as PaymentEnv,
        organizationId: input.organizationId,
        country: input.country.toUpperCase(),
        legalBusinessName: input.legalBusinessName,
        displayName: input.displayName,
        merchantType: input.merchantType ?? 'STANDARD',
        settlementCurrency: input.settlementCurrency.toUpperCase(),
        provider: input.provider.toLowerCase(),
        mode: input.mode ?? 'TEST',
        createdByUserId: actor.userId,
      },
    });
    await this.record(actor, 'MERCHANT_ONBOARDING_CREATED', row.id, {
      env: input.env,
      provider: row.provider,
    });
    return row;
  }

  async list(env?: PaymentEnvName, status?: OnboardingStatus): Promise<MerchantOnboarding[]> {
    return this.prisma.merchantOnboarding.findMany({
      where: {
        ...(env ? { env: env as PaymentEnv } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async detail(id: string) {
    const record = await this.require(id);
    return {
      record,
      checklist: onboardingChecklist(record),
      activationReady: isActivationReady(record),
    };
  }

  async update(id: string, patch: OnboardingPatch, actor: Actor): Promise<MerchantOnboarding> {
    const record = await this.require(id);
    if (!isEditable(record.status as OnboardingStatus)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Onboarding can only be edited in DRAFT/PENDING_CONFIGURATION (currently ${record.status}).`,
        HttpStatus.CONFLICT,
      );
    }
    const data: Record<string, unknown> = { ...patch };
    if (patch.country) data.country = patch.country.toUpperCase();
    if (patch.settlementCurrency) data.settlementCurrency = patch.settlementCurrency.toUpperCase();
    if (patch.provider) data.provider = patch.provider.toLowerCase();
    const row = await this.prisma.merchantOnboarding.update({ where: { id }, data });
    await this.record(actor, 'MERCHANT_ONBOARDING_UPDATED', id, { fields: Object.keys(patch) });
    return row;
  }

  /** Accept terms (records who + when). */
  async acceptTerms(id: string, actor: Actor): Promise<MerchantOnboarding> {
    await this.require(id);
    const row = await this.prisma.merchantOnboarding.update({
      where: { id },
      data: { termsAcceptedAt: new Date(), termsAcceptedBy: actor.userId },
    });
    await this.record(actor, 'MERCHANT_ONBOARDING_TERMS_ACCEPTED', id, {});
    return row;
  }

  /** Set webhook endpoint posture (NOT_CONFIGURED | CONFIGURED | VERIFIED). */
  async setWebhookStatus(id: string, status: string, actor: Actor): Promise<MerchantOnboarding> {
    await this.require(id);
    const row = await this.prisma.merchantOnboarding.update({
      where: { id },
      data: { webhookEndpointStatus: status },
    });
    await this.record(actor, 'MERCHANT_ONBOARDING_WEBHOOK_STATUS', id, { status });
    return row;
  }

  /** Set verification result (UNVERIFIED | IN_REVIEW | VERIFIED | FAILED). */
  async setVerification(id: string, status: string, actor: Actor): Promise<MerchantOnboarding> {
    await this.require(id);
    const row = await this.prisma.merchantOnboarding.update({
      where: { id },
      data: { verificationStatus: status },
    });
    await this.record(actor, 'MERCHANT_ONBOARDING_VERIFICATION', id, { status });
    return row;
  }

  /** Run a live provider health check against the merchant's own credentials. */
  async testConnection(id: string, actor: Actor) {
    const record = await this.require(id);
    let result: { healthy: boolean; mode?: string; message?: string };
    try {
      const provider = await this.factory.buildEphemeral({
        provider: record.provider,
        env: record.env as PaymentEnvName,
        mode: record.mode,
        publicKey: record.publicKey,
        secretKeyRef: record.secretKeyRef,
        webhookSecretRef: record.webhookSecretRef,
      });
      result = provider.healthCheck
        ? await provider.healthCheck()
        : { healthy: false, message: 'provider has no health check' };
    } catch (err) {
      // buildEphemeral throws secret-free reasons (validation / resolution).
      result = { healthy: false, message: err instanceof Error ? err.message : 'test failed' };
    }
    await this.record(actor, 'MERCHANT_ONBOARDING_TEST_CONNECTION', id, {
      provider: record.provider,
      healthy: result.healthy,
    });
    return result;
  }

  /** Generic guarded status transition (no side effects). */
  async transition(id: string, to: OnboardingStatus, actor: Actor): Promise<MerchantOnboarding> {
    const record = await this.require(id);
    this.assertTransition(record, to);
    if (to === 'PENDING_VERIFICATION' && !this.configComplete(record)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Cannot request verification until business, provider, account and secret references are complete.',
        HttpStatus.CONFLICT,
      );
    }
    const row = await this.prisma.merchantOnboarding.update({
      where: { id },
      data: { status: to },
    });
    await this.record(actor, 'MERCHANT_ONBOARDING_TRANSITION', id, { from: record.status, to });
    return row;
  }

  /**
   * Activate: requires READY_FOR_LIVE + all blocking checklist items done. Creates
   * (or links) a runtime MerchantAccount under the env's provider config.
   */
  async activate(id: string, actor: Actor): Promise<MerchantOnboarding> {
    const record = await this.require(id);
    this.assertTransition(record, 'ACTIVE');
    if (!isActivationReady(record)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Merchant is not activation-ready: complete all blocking checklist items first.',
        HttpStatus.CONFLICT,
      );
    }
    const config = await this.prisma.paymentProviderConfig.findUnique({
      where: { env_provider: { env: record.env, provider: record.provider } },
    });
    if (!config) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `No provider config exists for ${record.provider} in ${record.env}; create it before activating.`,
        HttpStatus.CONFLICT,
      );
    }
    const account = await this.prisma.merchantAccount.upsert({
      where: {
        configId_country_currency: {
          configId: config.id,
          country: record.country,
          currency: record.settlementCurrency,
        },
      },
      update: { label: record.displayName, merchantIdRef: record.accountIdentifier, active: true },
      create: {
        configId: config.id,
        label: record.displayName,
        country: record.country,
        currency: record.settlementCurrency,
        merchantIdRef: record.accountIdentifier,
        active: true,
      },
    });
    const row = await this.prisma.merchantOnboarding.update({
      where: { id },
      data: { status: 'ACTIVE', activatedAt: new Date(), merchantAccountId: account.id },
    });
    await this.record(actor, 'MERCHANT_ONBOARDING_ACTIVATED', id, {
      env: record.env,
      provider: record.provider,
      merchantAccountId: account.id,
    });
    return row;
  }

  async suspend(id: string, reason: string, actor: Actor): Promise<MerchantOnboarding> {
    const record = await this.require(id);
    this.assertTransition(record, 'SUSPENDED');
    if (record.merchantAccountId) {
      await this.prisma.merchantAccount
        .update({ where: { id: record.merchantAccountId }, data: { active: false } })
        .catch(() => undefined);
    }
    const row = await this.prisma.merchantOnboarding.update({
      where: { id },
      data: { status: 'SUSPENDED', suspendedAt: new Date() },
    });
    await this.record(actor, 'MERCHANT_ONBOARDING_SUSPENDED', id, { reason });
    return row;
  }

  async reject(id: string, reason: string, actor: Actor): Promise<MerchantOnboarding> {
    const record = await this.require(id);
    this.assertTransition(record, 'REJECTED');
    const row = await this.prisma.merchantOnboarding.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: reason },
    });
    await this.record(actor, 'MERCHANT_ONBOARDING_REJECTED', id, { reason });
    return row;
  }

  private configComplete(r: MerchantOnboarding): boolean {
    return Boolean(
      r.country &&
      r.legalBusinessName &&
      r.displayName &&
      r.settlementCurrency &&
      r.provider &&
      r.accountIdentifier &&
      r.secretKeyRef &&
      r.webhookSecretRef,
    );
  }

  private assertTransition(record: MerchantOnboarding, to: OnboardingStatus): void {
    if (!canTransition(record.status as OnboardingStatus, to)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Illegal transition ${record.status} → ${to}.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async require(id: string): Promise<MerchantOnboarding> {
    const record = await this.prisma.merchantOnboarding.findUnique({ where: { id } });
    if (!record) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Onboarding record not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return record;
  }

  private async record(
    actor: Actor,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorUserId: actor.userId,
      ip: actor.ip,
      action,
      entityType: 'MerchantOnboarding',
      entityId,
      metadata,
    });
  }
}
