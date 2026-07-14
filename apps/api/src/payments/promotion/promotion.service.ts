import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentEnv, PromotionRequest } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { SECRET_MANAGER, type SecretManager } from '../../secrets/secret-manager.interface';
import { isValidReference } from '../../secrets/secret-reference';
import type { PaymentEnvName } from '../configuration/payment-environment';
import { PaymentProviderFactory } from '../provider/factory/payment-provider.factory';
import { isDummyProvider, providerBinding } from '../provider/factory/provider-binding';
import {
  evaluatePromotion,
  expectedMode,
  isValidPromotionEdge,
  remapSecretRef,
  type PromotionReport,
} from './promotion.logic';

interface Actor {
  userId?: string;
  ip?: string | null;
}
interface Approval {
  userId: string;
  at: string;
  note?: string;
}

/**
 * Environment promotion (ADR-026). Validates a provider configuration for the next
 * environment (never a blind copy), records a promotion request with the report,
 * enforces approvals (two distinct approvers for PRODUCTION), and applies the
 * validated config to the target env on approval. Every step audited.
 */
@Injectable()
export class PromotionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(SECRET_MANAGER) private readonly secrets: SecretManager,
    private readonly factory: PaymentProviderFactory,
  ) {}

  /** Build (without persisting) the promotion validation report. */
  async buildReport(
    fromEnv: PaymentEnvName,
    toEnv: PaymentEnvName,
    provider: string,
  ): Promise<PromotionReport> {
    if (!isValidPromotionEdge(fromEnv, toEnv)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Invalid promotion path ${fromEnv} → ${toEnv}. Allowed: DEV→QA→UAT→STAGING→PRODUCTION.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const name = provider.toLowerCase();
    const source = await this.prisma.paymentProviderConfig.findUnique({
      where: { env_provider: { env: fromEnv as PaymentEnv, provider: name } },
    });
    if (!source) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        `Provider '${name}' is not configured in ${fromEnv}.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const secretRef = remapSecretRef(source.secretKeyRef, toEnv);
    const webhookRef = remapSecretRef(source.webhookSecretRef, toEnv);
    const refsPresent = Boolean(
      secretRef && webhookRef && isValidReference(secretRef) && isValidReference(webhookRef),
    );

    const smHealth = await this.secrets.healthCheck().catch(() => ({ healthy: false }));

    let secretsResolvable = false;
    let secret: string | undefined;
    try {
      if (secretRef) secret = await this.secrets.getSecret(secretRef);
      if (webhookRef) await this.secrets.getSecret(webhookRef);
      secretsResolvable = Boolean(secretRef && webhookRef);
    } catch {
      secretsResolvable = false;
    }

    const binding = providerBinding(name);
    const classified = binding
      ? binding.classifyMode({
          publicKey: source.publicKey ?? undefined,
          secret,
          apiBaseUrl: source.apiBaseUrl ?? undefined,
        })
      : 'unknown';

    const [routeCount, merchantCount] = await Promise.all([
      this.prisma.paymentRoute.count({
        where: {
          env: toEnv as PaymentEnv,
          active: true,
          OR: [{ provider: name }, { failoverProvider: name }],
        },
      }),
      this.prisma.merchantOnboarding.count({
        where: {
          env: toEnv as PaymentEnv,
          provider: name,
          status: { in: ['READY_FOR_LIVE', 'ACTIVE'] },
        },
      }),
    ]);

    let providerHealthPassing = false;
    try {
      const instance = await this.factory.buildEphemeral({
        provider: name,
        env: toEnv,
        mode: expectedMode(toEnv),
        publicKey: source.publicKey,
        secretKeyRef: secretRef,
        webhookSecretRef: webhookRef,
        apiBaseUrl: source.apiBaseUrl,
      });
      providerHealthPassing = instance.healthCheck ? (await instance.healthCheck()).healthy : false;
    } catch {
      providerHealthPassing = false;
    }

    return evaluatePromotion({
      fromEnv,
      toEnv,
      provider: name,
      sourceEnabled: source.enabled,
      isDummy: isDummyProvider(name),
      secretRefsPresent: refsPresent,
      secretManagerHealthy: smHealth.healthy,
      secretsResolvable,
      webhookConfigured: Boolean(source.webhookSecretRef),
      apiBaseUrl: source.apiBaseUrl,
      classified,
      routeExistsInTarget: routeCount > 0,
      merchantVerifiedInTarget: merchantCount > 0,
      providerHealthPassing,
      allowLiveKeysInLowerEnv:
        this.config.get<string>('PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV') === 'true',
    });
  }

  async createRequest(
    fromEnv: PaymentEnvName,
    toEnv: PaymentEnvName,
    provider: string,
    actor: Actor,
  ): Promise<PromotionRequest> {
    const report = await this.buildReport(fromEnv, toEnv, provider);
    const requiredApprovals = toEnv === 'PRODUCTION' ? 2 : 1;
    const row = await this.prisma.promotionRequest.create({
      data: {
        provider: provider.toLowerCase(),
        fromEnv: fromEnv as PaymentEnv,
        toEnv: toEnv as PaymentEnv,
        requiredApprovals,
        report: report as unknown as object,
        requestedByUserId: actor.userId,
      },
    });
    await this.record(actor, 'PAYMENT_PROMOTION_REQUESTED', row.id, {
      fromEnv,
      toEnv,
      provider,
      ok: report.ok,
      requiredApprovals,
    });
    return row;
  }

  async list(toEnv?: PaymentEnvName, status?: string): Promise<PromotionRequest[]> {
    return this.prisma.promotionRequest.findMany({
      where: {
        ...(toEnv ? { toEnv: toEnv as PaymentEnv } : {}),
        ...(status ? { status: status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approve(id: string, actor: Actor, note?: string): Promise<PromotionRequest> {
    const req = await this.require(id);
    if (req.status !== 'PENDING_APPROVAL') {
      throw this.conflict(`Promotion is ${req.status}, not awaiting approval.`);
    }
    if (!actor.userId) throw this.conflict('An authenticated approver is required.');

    const approvals = (req.approvals as unknown as Approval[]) ?? [];
    if (approvals.some((a) => a.userId === actor.userId)) {
      throw this.conflict('You have already approved this promotion.');
    }
    // Two-person integrity: the requester cannot be a required second approver.
    if (req.requiredApprovals > 1 && req.requestedByUserId === actor.userId) {
      throw this.conflict('The requester cannot approve a two-person promotion.');
    }

    approvals.push({ userId: actor.userId, at: new Date().toISOString(), note });
    const report = req.report as unknown as PromotionReport;
    const approved = approvals.length >= req.requiredApprovals && report.ok;

    const row = await this.prisma.promotionRequest.update({
      where: { id },
      data: {
        approvals: approvals as unknown as object,
        status: approved ? 'APPROVED' : 'PENDING_APPROVAL',
      },
    });
    await this.record(actor, 'PAYMENT_PROMOTION_APPROVED', id, {
      approvals: approvals.length,
      required: req.requiredApprovals,
      approved,
    });
    return row;
  }

  async reject(id: string, actor: Actor, reason: string): Promise<PromotionRequest> {
    const req = await this.require(id);
    if (req.status === 'APPLIED') throw this.conflict('An applied promotion cannot be rejected.');
    const row = await this.prisma.promotionRequest.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: reason },
    });
    await this.record(actor, 'PAYMENT_PROMOTION_REJECTED', id, { reason });
    return row;
  }

  /** Apply an approved promotion: write the validated config to the target env (disabled). */
  async apply(id: string, actor: Actor): Promise<PromotionRequest> {
    const req = await this.require(id);
    if (req.status !== 'APPROVED') {
      throw this.conflict(`Promotion must be APPROVED to apply (currently ${req.status}).`);
    }
    // Re-validate at apply time — config/secrets may have changed since approval.
    const fresh = await this.buildReport(
      req.fromEnv as PaymentEnvName,
      req.toEnv as PaymentEnvName,
      req.provider,
    );
    if (!fresh.ok) {
      throw this.conflict('Promotion re-validation failed; refusing to apply.');
    }

    const source = await this.prisma.paymentProviderConfig.findUnique({
      where: { env_provider: { env: req.fromEnv, provider: req.provider } },
    });
    if (!source) throw this.conflict('Source configuration no longer exists.');

    const toEnv = req.toEnv as PaymentEnvName;
    await this.prisma.paymentProviderConfig.upsert({
      where: { env_provider: { env: req.toEnv, provider: req.provider } },
      update: {
        mode: expectedMode(toEnv),
        publicKey: source.publicKey,
        secretKeyRef: remapSecretRef(source.secretKeyRef, toEnv),
        webhookSecretRef: remapSecretRef(source.webhookSecretRef, toEnv),
        apiBaseUrl: source.apiBaseUrl,
        priority: source.priority,
        // Enabling stays a deliberate, separate admin action (never auto-enabled).
        enabled: false,
      },
      create: {
        env: req.toEnv,
        provider: req.provider,
        enabled: false,
        mode: expectedMode(toEnv),
        publicKey: source.publicKey,
        secretKeyRef: remapSecretRef(source.secretKeyRef, toEnv),
        webhookSecretRef: remapSecretRef(source.webhookSecretRef, toEnv),
        apiBaseUrl: source.apiBaseUrl,
        priority: source.priority,
      },
    });

    const row = await this.prisma.promotionRequest.update({
      where: { id },
      data: { status: 'APPLIED', appliedAt: new Date(), report: fresh as unknown as object },
    });
    await this.record(actor, 'PAYMENT_PROMOTION_APPLIED', id, {
      fromEnv: req.fromEnv,
      toEnv: req.toEnv,
      provider: req.provider,
    });
    return row;
  }

  private async require(id: string): Promise<PromotionRequest> {
    const req = await this.prisma.promotionRequest.findUnique({ where: { id } });
    if (!req) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Promotion request not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return req;
  }

  private conflict(message: string): AppException {
    return new AppException(ErrorCodes.CONFLICT, message, HttpStatus.CONFLICT);
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
      entityType: 'PromotionRequest',
      entityId,
      metadata,
    });
  }
}
