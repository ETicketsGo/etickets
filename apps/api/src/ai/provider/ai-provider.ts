import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/** A single completion request. `input` is already PII-redacted by the gateway. */
export interface AiCompletionRequest {
  system: string;
  input: string;
  /** JSON schema hint for structured output (advisory to the provider). */
  wantsJson?: boolean;
  timeoutMs: number;
}

export interface AiCompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** Thrown when no provider is configured or a provider call fails — callers fall back. */
export class AiUnavailableError extends Error {
  constructor(message = 'AI provider unavailable') {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/**
 * Provider-neutral AI seam (mirrors the payment/push transport factory). A real
 * provider (OpenAI/Anthropic) is a drop-in behind this interface; none is shipped, so
 * the default is fully disabled and NEVER fabricates a response.
 */
export interface AiProvider {
  readonly name: string;
  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

/** The default: no model wired. Always throws so features use deterministic output. */
export class DisabledAiProvider implements AiProvider {
  readonly name = 'disabled';
  async complete(): Promise<AiCompletionResult> {
    throw new AiUnavailableError('AI is disabled (AI_PROVIDER=disabled)');
  }
}

export type AiProviderName = 'disabled' | 'openai' | 'anthropic';

/**
 * Selects the AI provider by AI_PROVIDER. Real providers require an SDK + key and are
 * intentionally NOT bundled — selecting one without a wired transport falls back to
 * Disabled (logged), so the platform never ships a fake integration.
 */
export function selectAiProvider(config: ConfigService): AiProvider {
  const name = (config.get<AiProviderName>('AI_PROVIDER') ?? 'disabled') as AiProviderName;
  if (name !== 'disabled') {
    new Logger('AI').warn(
      `AI_PROVIDER=${name} but no provider transport is wired; using the disabled provider. ` +
        'Features will use deterministic fallbacks.',
    );
  }
  return new DisabledAiProvider();
}
