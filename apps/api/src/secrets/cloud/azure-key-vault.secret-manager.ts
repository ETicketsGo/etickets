import { CloudSecretManager } from './cloud-secret-manager.base';
import type { SecretManagerHealth } from '../secret-manager.interface';
import { deriveKeyVaultName } from '../secret-reference';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Azure Key Vault secret manager (ADR-024). Feature-gated: requires
 * `@azure/keyvault-secrets` + `@azure/identity` installed and AZURE_KEY_VAULT_URL
 * set. Uses DefaultAzureCredential (managed identity / workload identity in cloud).
 * References map to vault secret names via slashes → hyphens.
 */
export class AzureKeyVaultSecretManager extends CloudSecretManager {
  readonly provider = 'azure';
  private client: any | null = null;

  constructor(
    private readonly vaultUrl: string | undefined,
    ttlMs: number,
    now: () => number = Date.now,
  ) {
    super(ttlMs, now);
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    if (!this.vaultUrl) throw new Error('AZURE_KEY_VAULT_URL is not configured');
    const secretsMod = await this.loadModule<any>('@azure/keyvault-secrets');
    const identityMod = await this.loadModule<any>('@azure/identity');
    if (!secretsMod || !identityMod) {
      throw new Error('@azure/keyvault-secrets and @azure/identity must be installed');
    }
    const credential = new identityMod.DefaultAzureCredential();
    this.client = new secretsMod.SecretClient(this.vaultUrl, credential);
    return this.client;
  }

  protected async fetchRemote(reference: string): Promise<string> {
    const client = await this.getClient();
    const secret = await client.getSecret(deriveKeyVaultName(reference));
    return secret?.value ?? '';
  }

  async healthCheck(): Promise<SecretManagerHealth> {
    if (!this.vaultUrl) {
      return { healthy: false, provider: this.provider, message: 'missing AZURE_KEY_VAULT_URL' };
    }
    try {
      await this.getClient();
      return { healthy: true, provider: this.provider, message: 'client initialised' };
    } catch (err) {
      return { healthy: false, provider: this.provider, message: this.safeReason(err) };
    }
  }
}
