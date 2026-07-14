import { CloudSecretManager } from './cloud-secret-manager.base';
import type { SecretManagerHealth } from '../secret-manager.interface';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * AWS Secrets Manager secret manager (ADR-024). Feature-gated: requires
 * `@aws-sdk/client-secrets-manager` installed and AWS_SECRETS_REGION set (AWS
 * credentials come from the default provider chain — IAM role / env / profile).
 * The reference is used directly as the SecretId.
 */
export class AwsSecretsManagerSecretManager extends CloudSecretManager {
  readonly provider = 'aws';
  private client: any | null = null;
  private commandCtor: any | null = null;

  constructor(
    private readonly region: string | undefined,
    ttlMs: number,
    now: () => number = Date.now,
  ) {
    super(ttlMs, now);
  }

  private async getClient(): Promise<{ client: any; GetSecretValueCommand: any }> {
    if (this.client && this.commandCtor) {
      return { client: this.client, GetSecretValueCommand: this.commandCtor };
    }
    if (!this.region) throw new Error('AWS_SECRETS_REGION is not configured');
    const mod = await this.loadModule<any>('@aws-sdk/client-secrets-manager');
    if (!mod) throw new Error('@aws-sdk/client-secrets-manager must be installed');
    this.client = new mod.SecretsManagerClient({ region: this.region });
    this.commandCtor = mod.GetSecretValueCommand;
    return { client: this.client, GetSecretValueCommand: this.commandCtor };
  }

  protected async fetchRemote(reference: string): Promise<string> {
    const { client, GetSecretValueCommand } = await this.getClient();
    const res = await client.send(new GetSecretValueCommand({ SecretId: reference }));
    return res?.SecretString ?? '';
  }

  async healthCheck(): Promise<SecretManagerHealth> {
    if (!this.region) {
      return { healthy: false, provider: this.provider, message: 'missing AWS_SECRETS_REGION' };
    }
    try {
      await this.getClient();
      return { healthy: true, provider: this.provider, message: 'client initialised' };
    } catch (err) {
      return { healthy: false, provider: this.provider, message: this.safeReason(err) };
    }
  }
}
