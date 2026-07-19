import { Injectable } from '@nestjs/common';

/** A versioned prompt template. `build` receives the (already-sanitised) input. */
export interface PromptTemplate {
  key: string;
  version: string;
  system: string;
  build: (input: string) => string;
}

/**
 * Versioned prompt registry (v2.0 WS1). Prompts are code-defined so versions are
 * reviewable and pinned; the ops console reports which version served each call. The
 * ONLY instruction to any model is to rephrase authoritative facts — never to compute
 * or invent numbers (those come from analytics/reports deterministically).
 */
@Injectable()
export class PromptRegistry {
  private readonly templates: Record<string, PromptTemplate> = {
    'organizer.assistant': {
      key: 'organizer.assistant',
      version: '2026-07-19.1',
      system:
        'You are an organizer analytics assistant. Answer ONLY from the provided facts. ' +
        'Never invent numbers. If a fact is absent, say it is unavailable. Be concise.',
      build: (input) => input,
    },
    'event.summary': {
      key: 'event.summary',
      version: '2026-07-19.1',
      system:
        'Rephrase the provided event metrics into a concise summary. Do not add, remove ' +
        'or alter any number. No predictions or guarantees.',
      build: (input) => input,
    },
    'content.draft': {
      key: 'content.draft',
      version: '2026-07-19.1',
      system:
        'Draft promotional copy from the organizer-provided facts only. Never invent ' +
        'venues, dates, performers, pricing, policies or availability. Mark as a draft.',
      build: (input) => input,
    },
  };

  get(key: string): PromptTemplate {
    const tpl = this.templates[key];
    if (!tpl) throw new Error(`Unknown prompt key: ${key}`);
    return tpl;
  }

  /** All prompt keys + versions (for the ops console). */
  versions(): { key: string; version: string }[] {
    return Object.values(this.templates).map((t) => ({ key: t.key, version: t.version }));
  }
}
