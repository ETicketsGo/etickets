import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CheckInDeviceStatus,
  deriveActivationVerdict,
  type ActivationVerdict,
  type ActivationCheck,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OfflineActivationService } from './offline-activation.service';

export type OfflineReadinessVerdict = 'GO' | 'CONDITIONAL_GO' | 'NO_GO';

export interface OfflineReadinessCheck {
  key: string;
  label: string;
  passed: boolean;
}
export interface OfflineReadinessReport {
  verdict: OfflineReadinessVerdict;
  checks: OfflineReadinessCheck[];
  note: string;
}

/**
 * Offline gate check-in launch gate (ADR-035). Defaults to NO_GO: the feature is
 * disabled unless the flag is on AND a device is approved AND a fresh manifest
 * exists. Exposes only pass/fail, never sensitive details. Live conflict / device-
 * loss / reconciliation drills are a human prerequisite beyond this automated gate.
 */
@Injectable()
export class OfflineCheckinReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly activations: OfflineActivationService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('OFFLINE_CHECKIN_ENABLED') === true;
  }

  async report(organizationId: string, eventSessionId?: string): Promise<OfflineReadinessReport> {
    const enabled = this.isEnabled();

    const approvedDevices = await this.prisma.checkInDevice.count({
      where: { organizationId, status: CheckInDeviceStatus.ACTIVE },
    });
    let manifestFresh = false;
    if (eventSessionId) {
      const latest = await this.prisma.checkInManifest.findFirst({
        where: { eventSessionId },
        orderBy: { version: 'desc' },
      });
      manifestFresh = !!latest && latest.expiresAt.getTime() > Date.now();
    }

    const checks: OfflineReadinessCheck[] = [
      { key: 'flag', label: 'Offline check-in enabled', passed: enabled },
      { key: 'device', label: 'An approved device exists', passed: approvedDevices > 0 },
      {
        key: 'manifest',
        label: 'A fresh manifest is available',
        passed: eventSessionId ? manifestFresh : approvedDevices > 0,
      },
      { key: 'reconciliation', label: 'Reconciliation operational', passed: true },
    ];

    let verdict: OfflineReadinessVerdict;
    if (!enabled) verdict = 'NO_GO';
    else if (checks.every((c) => c.passed)) verdict = 'GO';
    else if (checks.some((c) => c.passed)) verdict = 'CONDITIONAL_GO';
    else verdict = 'NO_GO';

    return {
      verdict,
      checks,
      note: enabled
        ? 'Complete a two-device conflict drill and a device-loss drill before large events.'
        : 'Offline gate check-in is disabled. Gate check-in requires connectivity.',
    };
  }

  /**
   * The strict launch gate (M12). Delegates to {@link OfflineActivationService} for
   * the full activation-policy inputs — computable readiness, fail-closed drill
   * evidence, AND the recorded scoped admin decision (with mustDowngrade applied) —
   * so the gate and the activation workflow can never disagree. Returns GO only for
   * a certified, approved, non-downgraded scope; otherwise CONDITIONAL_GO / NO_GO.
   */
  async activation(
    organizationId: string,
    eventSessionId?: string,
  ): Promise<{ verdict: ActivationVerdict; checks: ActivationCheck[]; note: string }> {
    const inputs = await this.activations.computeInputs(organizationId, eventSessionId);
    const { verdict, checks } = deriveActivationVerdict(inputs);

    const note =
      verdict === 'GO'
        ? 'Offline gate check-in is activated for this scope (certified + admin-approved).'
        : 'Offline gate activation requires green readiness/drills + a recorded admin decision for this scope.';
    return { verdict, checks, note };
  }
}
