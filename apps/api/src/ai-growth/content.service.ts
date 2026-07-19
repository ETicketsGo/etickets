import { Injectable } from '@nestjs/common';
import { AiGateway } from '../ai/ai-gateway.service';
import { AiConfigService } from '../ai/ai-config.service';
import type { RequestUser } from '../common/decorators';

export type ContentKind = 'description' | 'caption' | 'email' | 'faq' | 'reminder' | 'social';

export interface ContentDraftInput {
  kind: ContentKind;
  title: string;
  city?: string;
  venue?: string;
  dateText?: string;
  highlights?: string;
}

/**
 * Organizer content drafting (v2.0 WS7). Draft-only, human-review-required. Builds
 * copy ONLY from organizer-provided facts — never invents venues, dates, performers,
 * pricing, policies or availability. Deterministic templates are the default; an AI
 * provider (when enabled) may rephrase them, still bound to the same facts.
 */
@Injectable()
export class ContentService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly ai: AiConfigService,
  ) {}

  async draft(user: RequestUser, input: ContentDraftInput) {
    const where = [input.venue, input.city].filter(Boolean).join(', ');
    const when = input.dateText?.trim();
    const facts = [
      input.title,
      where ? `at ${where}` : '',
      when ? `on ${when}` : '',
      input.highlights?.trim() ? `Highlights: ${input.highlights.trim()}` : '',
    ]
      .filter(Boolean)
      .join(' — ');

    const drafts = this.templates(input, where, when);

    // Optional AI rephrasing, still bound to the same facts (disabled by default).
    const ai = await this.gateway.run({
      feature: 'content.draft',
      promptKey: 'content.draft',
      input: `Kind: ${input.kind}\nFacts: ${facts}\nDraft: ${drafts[0]}`,
      actorUserId: user.id,
    });

    return {
      aiEnabled: this.ai.isEnabled(),
      generated: ai.ok,
      // Everything here is a DRAFT for human review — never auto-published.
      label: 'AI-assisted draft — review before publishing',
      drafts: ai.ok && ai.text ? [ai.text, ...drafts] : drafts,
    };
  }

  private templates(input: ContentDraftInput, where: string, when?: string): string[] {
    const t = input.title.trim();
    const loc = where ? ` at ${where}` : '';
    const date = when ? ` on ${when}` : '';
    const hl = input.highlights?.trim();

    switch (input.kind) {
      case 'description':
        return [`${t}${loc}${date}.${hl ? ` ${hl}.` : ''} Book your tickets now on ETicketsGo.`];
      case 'caption':
        return [
          `🎟️ ${t}${date}. Don't miss out${loc ? ` — ${where}` : ''}!`,
          `${t} is coming${date}. Grab your spot today.`,
        ];
      case 'social':
        return [
          `We're excited to announce ${t}${loc}${date}!${hl ? ` ${hl}.` : ''} Tickets are live. #ETicketsGo`,
        ];
      case 'email':
        return [
          `Subject: You're invited to ${t}\n\nHi there,\n\nJoin us for ${t}${loc}${date}.${
            hl ? ` ${hl}.` : ''
          }\n\nGet your tickets on ETicketsGo. See you there!`,
        ];
      case 'reminder':
        return [
          `Reminder: ${t} is${date ? ` ${when}` : ' coming up soon'}${loc}. Have your ticket ready for check-in.`,
        ];
      case 'faq':
        return [
          `Q: Where is ${t}?\nA: ${where || 'See the event page for the venue.'}\n\nQ: When does it start?\nA: ${
            when || 'See the event page for timing.'
          }\n\nQ: Can I get a refund?\nA: Refunds follow the organizer's stated policy on the event page.`,
        ];
      default:
        return [t];
    }
  }
}
