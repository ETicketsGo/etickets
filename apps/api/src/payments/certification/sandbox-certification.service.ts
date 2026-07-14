import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { MerchantCertification, PaymentEnv } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { PaymentEnvName } from '../configuration/payment-environment';
import { PaymentProviderFactory } from '../provider/factory/payment-provider.factory';
import { isDummyProvider } from '../provider/factory/provider-binding';
import { MockPaymentProvider } from '../provider/mock-payment.provider';
import type { PaymentProvider } from '../provider/payment-provider.interface';
import { runCertificationSteps, summarize, type StepResult } from './certification-steps';

interface Actor {
  userId?: string;
  ip?: string | null;
}

/**
 * Sandbox certification (ADR-027). Runs the automated end-to-end certification for
 * a merchant/provider and persists an evidence record. For the dummy provider it
 * runs a fully self-contained lifecycle (CI-safe); for a real provider it drives
 * the adapter against the sandbox — only ever via the admin action or the opt-in
 * command, never from the normal test suite.
 */
@Injectable()
export class SandboxCertificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly factory: PaymentProviderFactory,
    private readonly mock: MockPaymentProvider,
  ) {}

  async certifyOnboarding(onboardingId: string, actor: Actor): Promise<MerchantCertification> {
    const onboarding = await this.prisma.merchantOnboarding.findUnique({
      where: { id: onboardingId },
    });
    if (!onboarding) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Onboarding record not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.run({
      merchantOnboardingId: onboarding.id,
      env: onboarding.env as PaymentEnvName,
      provider: onboarding.provider,
      currency: onboarding.settlementCurrency,
      mode: onboarding.mode,
      publicKey: onboarding.publicKey,
      secretKeyRef: onboarding.secretKeyRef,
      webhookSecretRef: onboarding.webhookSecretRef,
      operator: actor.userId,
    });
  }

  async list(onboardingId?: string): Promise<MerchantCertification[]> {
    return this.prisma.merchantCertification.findMany({
      where: onboardingId ? { merchantOnboardingId: onboardingId } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** Core run: resolve the provider, execute the steps, persist the evidence. */
  async run(input: {
    merchantOnboardingId?: string;
    env: PaymentEnvName;
    provider: string;
    currency: string;
    mode: 'DUMMY' | 'TEST' | 'LIVE';
    publicKey?: string | null;
    secretKeyRef?: string | null;
    webhookSecretRef?: string | null;
    operator?: string;
  }): Promise<MerchantCertification> {
    const bookingId = `cert_${randomBytes(6).toString('hex')}`;
    let steps: StepResult[];

    try {
      let provider: PaymentProvider;
      let signer:
        | ((e: Parameters<typeof this.mock.signEvent>[0]) => ReturnType<typeof this.mock.signEvent>)
        | undefined;
      if (isDummyProvider(input.provider)) {
        provider = this.mock;
        signer = (e) => this.mock.signEvent(e);
      } else {
        provider = await this.factory.buildEphemeral({
          provider: input.provider,
          env: input.env,
          mode: input.mode,
          publicKey: input.publicKey,
          secretKeyRef: input.secretKeyRef,
          webhookSecretRef: input.webhookSecretRef,
        });
      }
      steps = await runCertificationSteps(provider, {
        amountMinor: 100,
        currency: input.currency || 'USD',
        bookingId,
        buyerEmail: 'certification@eticketsgo.test',
        signer,
      });
    } catch (err) {
      // Provider could not even be built (bad/missing creds) — record a failed cert.
      steps = [
        {
          step: 1,
          key: 'health',
          label: 'Provider health check',
          status: 'FAIL',
          detail: err instanceof Error ? err.message : 'provider could not be built',
        },
      ];
    }

    const summary = summarize(steps);
    const certification = await this.prisma.merchantCertification.create({
      data: {
        merchantOnboardingId: input.merchantOnboardingId,
        env: input.env as PaymentEnv,
        provider: input.provider.toLowerCase(),
        result: summary.result,
        steps: steps as unknown as object,
        passedCount: summary.passedCount,
        failedCount: summary.failedCount,
        skippedCount: summary.skippedCount,
        operator: input.operator,
      },
    });

    await this.audit.record({
      actorUserId: input.operator,
      action: 'PAYMENT_CERTIFICATION_RUN',
      entityType: 'MerchantCertification',
      entityId: certification.id,
      metadata: {
        env: input.env,
        provider: input.provider,
        result: summary.result,
        passed: summary.passedCount,
        failed: summary.failedCount,
        skipped: summary.skippedCount,
      },
    });

    return certification;
  }
}
