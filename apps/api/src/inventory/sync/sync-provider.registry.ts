import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnknownInventorySyncProviderError } from './sync.errors';
import type { InventorySyncProvider } from './contracts/sync-provider.interface';

/**
 * Registry of constructed {@link InventorySyncProvider} adapters, keyed by providerCode
 * (mirrors the P1 sourcing/payment registries). `resolve` additionally enforces the
 * `INVENTORY_SYNC_PROVIDER_ALLOWLIST` — a provider not on the allowlist is treated as
 * unknown (fail safe), so a mis-registered adapter can never accept traffic. A provider
 * code is validated `[a-z0-9_-]` to prevent path/key injection from the URL segment.
 */
@Injectable()
export class InventorySyncProviderRegistry {
  private readonly byCode = new Map<string, InventorySyncProvider>();

  constructor(private readonly config: ConfigService) {}

  register(provider: InventorySyncProvider): void {
    this.byCode.set(provider.providerCode.toLowerCase(), provider);
  }

  has(code: string): boolean {
    return this.byCode.has(code.toLowerCase());
  }

  /** Internal lookup (no allowlist gate) for processing already-accepted events. */
  get(code: string): InventorySyncProvider | undefined {
    return this.byCode.get(code.toLowerCase());
  }

  list(): InventorySyncProvider[] {
    return Array.from(this.byCode.values());
  }

  /** Resolve a provider for ingestion: must exist AND be on the allowlist. */
  resolve(code: string): InventorySyncProvider {
    if (!/^[a-z0-9_-]{1,64}$/.test(code)) {
      throw new UnknownInventorySyncProviderError();
    }
    const key = code.toLowerCase();
    if (!this.allowlisted(key) || !this.byCode.has(key)) {
      throw new UnknownInventorySyncProviderError();
    }
    return this.byCode.get(key) as InventorySyncProvider;
  }

  private allowlisted(code: string): boolean {
    const raw = this.config.get<string>('INVENTORY_SYNC_PROVIDER_ALLOWLIST') ?? '';
    const allow = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return allow.includes(code);
  }
}
