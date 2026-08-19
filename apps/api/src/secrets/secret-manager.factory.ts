import { ConfigService } from '@nestjs/config';
import { EnvironmentSecretManager } from './environment-secret-manager';
import { AzureKeyVaultSecretManager } from './cloud/azure-key-vault.secret-manager';
import { AwsSecretsManagerSecretManager } from './cloud/aws-secrets-manager.secret-manager';
import { GcpSecretManager } from './cloud/gcp.secret-manager';
import type { SecretManager } from './secret-manager.interface';

export type SecretManagerProvider = 'env' | 'azure' | 'aws' | 'gcp';

/**
 * Environments where a LIVE credential may exist, and where the env-var backend is
 * therefore refused.
 *
 * ── WHY NOT UAT ───────────────────────────────────────────────────────────────────
 * UAT used to be in this set, which put two of our own controls in contradiction:
 *
 *   `isLiveAllowed` = STAGING | PRODUCTION  — UAT may NEVER hold a live key; boot rejects
 *                                            `rzp_live_`/`sk_live_` there outright.
 *   this set (old)  = UAT | STAGING | PRODUCTION — UAT must protect live keys with a
 *                                            managed vault.
 *
 * UAT was required to guard credentials it is forbidden from having. The vault exists to
 * keep real money-moving secrets out of a dashboard variable; in UAT, by construction,
 * there are none. So the requirement protected nothing and made the environment
 * unbootable — a freshly provisioned UAT started and died with this very error, and the
 * variable appeared in no template, runbook or config check.
 *
 * The invariant that actually matters is not an environment NAME, it is whether a live
 * credential could be present. So: forbidden wherever live keys are allowed, plus wherever
 * somebody has deliberately switched them on in a lower environment.
 *
 * That last clause CLOSES A HOLE the name-based rule left open: with
 * `PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV=true` you could previously load a live key into QA or
 * DEV and read it straight from an env var, because neither was on the forbidden list.
 */
const LIVE_CREDENTIAL_ENVS = new Set(['STAGING', 'PRODUCTION']);

/**
 * Select the SecretManager from configuration (ADR-024). Enforces that PRODUCTION
 * (and other protected envs) never use the environment backend, so real credentials
 * are always sourced from a managed secret store. Only the selected backend is
 * constructed; cloud SDKs load lazily at first use.
 */
export function selectSecretManager(config: ConfigService): SecretManager {
  const provider = (config.get<SecretManagerProvider>('SECRET_MANAGER_PROVIDER') ??
    'env') as SecretManagerProvider;
  const appEnv = (config.get<string>('APP_ENV') ?? 'LOCAL').toUpperCase();
  const ttlMs = config.get<number>('SECRET_CACHE_TTL_MS') ?? 300_000;

  // Live keys can be forced into a lower environment by explicit override; where that is
  // on, the env backend is refused there too.
  const liveKeysPossible =
    LIVE_CREDENTIAL_ENVS.has(appEnv) ||
    config.get<string>('PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV') === 'true';

  if (provider === 'env' && liveKeysPossible) {
    throw new Error(
      `SECRET_MANAGER_PROVIDER=env is not permitted where live credentials can exist ` +
        `(APP_ENV=${appEnv}). Configure a managed secret store (azure | aws | gcp).`,
    );
  }

  switch (provider) {
    case 'azure':
      return new AzureKeyVaultSecretManager(config.get<string>('AZURE_KEY_VAULT_URL'), ttlMs);
    case 'aws':
      return new AwsSecretsManagerSecretManager(config.get<string>('AWS_SECRETS_REGION'), ttlMs);
    case 'gcp':
      return new GcpSecretManager(config.get<string>('GCP_PROJECT_ID'), ttlMs);
    case 'env':
    default:
      return new EnvironmentSecretManager(process.env, ttlMs);
  }
}
