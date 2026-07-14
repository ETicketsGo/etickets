/* eslint-disable no-console */
/**
 * Opt-in sandbox certification command (ADR-027). Runs the end-to-end certification
 * for a merchant onboarding record against its (sandbox) provider. This makes REAL
 * provider calls for non-dummy providers, so it is deliberately NOT part of the
 * automated test suite — it must be invoked explicitly and requires the merchant's
 * sandbox credentials to be resolvable by the configured secret manager.
 *
 * Usage:
 *   CERTIFY_ENABLED=true npm run certify -- <merchantOnboardingId>
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { SandboxCertificationService } from './sandbox-certification.service';

async function main(): Promise<void> {
  if (process.env.CERTIFY_ENABLED !== 'true') {
    console.error('Refusing to run: set CERTIFY_ENABLED=true to opt in to real sandbox calls.');
    process.exit(2);
  }
  const onboardingId = process.argv[2];
  if (!onboardingId) {
    console.error('Usage: CERTIFY_ENABLED=true npm run certify -- <merchantOnboardingId>');
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const service = app.get(SandboxCertificationService);
    const cert = await service.certifyOnboarding(onboardingId, { userId: 'cli' });
    console.log(`\nCertification ${cert.result} for ${cert.provider} (${cert.env})`);
    console.log(
      `  passed=${cert.passedCount} failed=${cert.failedCount} skipped=${cert.skippedCount}`,
    );
    console.log('  steps:');
    for (const step of cert.steps as unknown as {
      step: number;
      label: string;
      status: string;
      detail?: string;
    }[]) {
      console.log(
        `   ${step.step}. [${step.status}] ${step.label}${step.detail ? ` — ${step.detail}` : ''}`,
      );
    }
    process.exit(cert.result === 'FAIL' ? 1 : 0);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Certification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
