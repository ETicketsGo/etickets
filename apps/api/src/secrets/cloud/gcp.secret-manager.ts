import { CloudSecretManager } from './cloud-secret-manager.base';
import type { SecretManagerHealth } from '../secret-manager.interface';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GCP Secret Manager secret manager (ADR-024). Feature-gated: requires
 * `@google-cloud/secret-manager` installed and GCP_PROJECT_ID set (credentials via
 * Application Default Credentials). References map to secret ids via `/` → `_`, and
 * the latest version is accessed.
 */
export class GcpSecretManager extends CloudSecretManager {
  readonly provider = 'gcp';
  private client: any | null = null;

  constructor(
    private readonly projectId: string | undefined,
    ttlMs: number,
    now: () => number = Date.now,
  ) {
    super(ttlMs, now);
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    if (!this.projectId) throw new Error('GCP_PROJECT_ID is not configured');
    const mod = await this.loadModule<any>('@google-cloud/secret-manager');
    if (!mod) throw new Error('@google-cloud/secret-manager must be installed');
    this.client = new mod.SecretManagerServiceClient();
    return this.client;
  }

  private secretId(reference: string): string {
    return reference.replace(/\//g, '_');
  }

  protected async fetchRemote(reference: string): Promise<string> {
    const client = await this.getClient();
    const name = `projects/${this.projectId}/secrets/${this.secretId(reference)}/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });
    const payload = version?.payload?.data;
    if (!payload) return '';
    return Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  }

  async healthCheck(): Promise<SecretManagerHealth> {
    if (!this.projectId) {
      return { healthy: false, provider: this.provider, message: 'missing GCP_PROJECT_ID' };
    }
    try {
      await this.getClient();
      return { healthy: true, provider: this.provider, message: 'client initialised' };
    } catch (err) {
      return { healthy: false, provider: this.provider, message: this.safeReason(err) };
    }
  }
}
