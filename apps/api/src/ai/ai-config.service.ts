import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiProviderName } from './provider/ai-provider';

export interface AiStatus {
  enabled: boolean;
  provider: AiProviderName;
  model: string | null;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Central AI posture (v2.0 WS1). Disabled by default — `enabled` is only true when a
 * real provider is configured. Every AI feature checks this and uses its deterministic
 * fallback when false, so nothing depends on a provider being present.
 */
@Injectable()
export class AiConfigService {
  constructor(private readonly config: ConfigService) {}

  get provider(): AiProviderName {
    return (this.config.get<AiProviderName>('AI_PROVIDER') ?? 'disabled') as AiProviderName;
  }

  isEnabled(): boolean {
    return this.provider !== 'disabled';
  }

  get timeoutMs(): number {
    return this.config.get<number>('AI_TIMEOUT_MS') ?? 8000;
  }

  get maxRetries(): number {
    return this.config.get<number>('AI_MAX_RETRIES') ?? 1;
  }

  get costPer1kMinor(): number {
    return this.config.get<number>('AI_COST_PER_1K_MINOR') ?? 0;
  }

  status(): AiStatus {
    return {
      enabled: this.isEnabled(),
      provider: this.provider,
      model: this.config.get<string>('AI_MODEL') ?? null,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    };
  }
}
