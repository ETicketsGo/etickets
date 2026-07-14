import { ConfigService } from '@nestjs/config';
import { EnvironmentSecretManager } from './environment-secret-manager';
import { AzureKeyVaultSecretManager } from './cloud/azure-key-vault.secret-manager';
import { AwsSecretsManagerSecretManager } from './cloud/aws-secrets-manager.secret-manager';
import { GcpSecretManager } from './cloud/gcp.secret-manager';
import type { SecretManager } from './secret-manager.interface';

export type SecretManagerProvider = 'env' | 'azure' | 'aws' | 'gcp';

/** Environments where the env-var backend must never be used (fail closed). */
const ENV_BACKEND_FORBIDDEN = new Set(['UAT', 'STAGING', 'PRODUCTION']);

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

  if (provider === 'env' && ENV_BACKEND_FORBIDDEN.has(appEnv)) {
    throw new Error(
      `SECRET_MANAGER_PROVIDER=env is not permitted in ${appEnv}. ` +
        `Configure a managed secret store (azure | aws | gcp).`,
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
