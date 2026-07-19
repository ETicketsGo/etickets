import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactPii } from '@eticketsgo/shared-types';
import { AiConfigService } from './ai-config.service';
import { AiUsageService } from './ai-usage.service';
import { PromptRegistry } from './prompts/prompt-registry';
import { AI_PROVIDER, AiUnavailableError, type AiProvider } from './provider/ai-provider';

export interface AiRunOptions {
  feature: string;
  promptKey: string;
  /** Raw input; the gateway redacts PII before it reaches a provider. */
  input: string;
  organizationId?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

export interface AiRunResult {
  /** true only when a provider genuinely produced text. */
  ok: boolean;
  /** Present when ok; the provider's (rephrased) text. */
  text?: string;
  /** true when the caller should use its deterministic fallback. */
  fallback: boolean;
  provider: string;
  promptVersion: string;
}

/**
 * The single entry point to the AI layer (v2.0 WS1). Enforces the safety envelope on
 * every call: disabled-by-default gate, PII redaction, timeout, bounded retries,
 * usage/cost/latency telemetry, and fail-safe fallback (never throws into callers).
 * When disabled or on any failure it returns `{ ok:false, fallback:true }` and the
 * caller serves its deterministic result.
 */
@Injectable()
export class AiGateway {
  private readonly logger = new Logger('AiGateway');

  constructor(
    private readonly ai: AiConfigService,
    private readonly usage: AiUsageService,
    private readonly prompts: PromptRegistry,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  async run(opts: AiRunOptions): Promise<AiRunResult> {
    const tpl = this.prompts.get(opts.promptKey);
    const base = {
      feature: opts.feature,
      promptKey: tpl.key,
      promptVersion: tpl.version,
      organizationId: opts.organizationId ?? null,
      actorUserId: opts.actorUserId ?? null,
      correlationId: opts.correlationId ?? null,
    };
    const fallback = (status: 'disabled' | 'fallback' | 'error', redactions = 0): AiRunResult => {
      void this.usage.record({ ...base, provider: this.ai.provider, status, redactions });
      return { ok: false, fallback: true, provider: this.ai.provider, promptVersion: tpl.version };
    };

    if (!this.ai.isEnabled()) return fallback('disabled');

    // PII-safe input: redact before anything leaves the process.
    const { text: safeInput, counts } = redactPii(opts.input);
    const redactions = counts.email + counts.phone + counts.longDigits + counts.reference;

    const start = Date.now();
    try {
      const result = await this.withRetries(() =>
        this.withTimeout(
          this.provider.complete({
            system: tpl.system,
            input: tpl.build(safeInput),
            timeoutMs: this.ai.timeoutMs,
          }),
          this.ai.timeoutMs,
        ),
      );
      const latencyMs = Date.now() - start;
      const costMinor = Math.round(
        ((result.tokensIn + result.tokensOut) / 1000) * this.ai.costPer1kMinor,
      );
      await this.usage.record({
        ...base,
        provider: this.provider.name,
        status: 'success',
        latencyMs,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costMinor,
        redactions,
      });
      return {
        ok: true,
        text: result.text,
        fallback: false,
        provider: this.provider.name,
        promptVersion: tpl.version,
      };
    } catch (err) {
      const status = err instanceof AiUnavailableError ? 'fallback' : 'error';
      if (status === 'error') this.logger.warn(`ai run failed: ${(err as Error).message}`);
      return fallback(status, redactions);
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AiUnavailableError('AI request timed out')), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.ai.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        // Do not retry a hard "unavailable" (disabled/timeout) — only transient errors.
        if (err instanceof AiUnavailableError) throw err;
      }
    }
    throw lastErr;
  }
}
