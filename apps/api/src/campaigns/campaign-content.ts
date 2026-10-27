import { z } from 'zod';
import { ConsentPurpose, type OrganizerPurpose } from '../engagement/consent-purpose';

/**
 * What a campaign email is made of: a short list of typed blocks. Never HTML.
 *
 * ── WHY BLOCKS ─────────────────────────────────────────────────────────────────────
 * An email sent under ETicketsGo's name is our reputation with every mailbox provider. Free
 * HTML would let one organizer paste a tracking pixel, a script, a form or a look-alike login
 * page into mail that carries our domain. Blocks give the organizer the parts a ticketing email
 * needs (a heading, words, an event card, one button) and give the renderer the only say over
 * markup. Every text is escaped there; every link goes through the click tracker, which only
 * redirects to hosts this platform owns.
 *
 * ── NO ARBITRARY IMAGES ────────────────────────────────────────────────────────────
 * An image is chosen by SOURCE (the event's poster, the organizer's logo), never by URL. Both
 * are served by our API, so an image cannot become a remote tracking pixel and cannot point at
 * somebody else's server.
 */

export const TEXT_MAX = 2000;
export const BLOCKS_MAX = 30;

const text = (max = TEXT_MAX) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // No control characters other than line breaks. A NUL or a bidi override in a subject is
    // how a spoofed sender or a hidden phrase gets through a reviewer's eye.
    .refine((s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/.test(s), {
      message: 'Remove the hidden control characters from this text.',
    });

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: text(150) }),
  z.object({ type: z.literal('paragraph'), text: text() }),
  z.object({
    type: z.literal('image'),
    source: z.enum(['EVENT', 'ORGANIZER_LOGO']),
    alt: text(150),
  }),
  z.object({
    type: z.literal('button'),
    label: text(60),
    /** Checked against the owned-host allowlist when saved AND when rendered. */
    url: z.string().trim().url().max(1000),
  }),
  /** A card for one of THIS organizer's events: title, next date, venue, poster, Book button. */
  z.object({ type: z.literal('event'), eventId: z.string().trim().min(1).max(64) }),
  /** A promo code and the words around it. The code is shown, not applied. */
  z.object({
    type: z.literal('offer'),
    text: text(300),
    code: z
      .string()
      .trim()
      .max(40)
      .regex(/^[A-Za-z0-9_-]*$/, 'A code uses letters, numbers, dashes and underscores only.')
      .optional(),
  }),
  z.object({ type: z.literal('divider') }),
]);
export type CampaignBlock = z.infer<typeof blockSchema>;

export const contentSchema = z.object({
  blocks: z.array(blockSchema).min(1).max(BLOCKS_MAX),
});
export type CampaignContent = z.infer<typeof contentSchema>;

export const CampaignTemplateKey = {
  EVENT_ANNOUNCEMENT: 'EVENT_ANNOUNCEMENT',
  EARLY_BIRD: 'EARLY_BIRD',
  UPCOMING_SHOWS: 'UPCOMING_SHOWS',
  OFFER: 'OFFER',
  THANK_YOU: 'THANK_YOU',
} as const;
export type CampaignTemplateKey = (typeof CampaignTemplateKey)[keyof typeof CampaignTemplateKey];
export const TEMPLATE_KEYS = Object.values(CampaignTemplateKey) as [
  CampaignTemplateKey,
  ...CampaignTemplateKey[],
];

export interface CampaignTemplate {
  key: CampaignTemplateKey;
  label: string;
  description: string;
  /** The consent the template's kind of email needs. The organizer can pick another. */
  purpose: OrganizerPurpose;
  /** Whether the template is built around one event (the event card and the Book button). */
  needsEvent: boolean;
  subject: string;
  previewText: string;
  /** The starting blocks. `{event}` and `{organizer}` are filled in when a draft is made. */
  blocks: CampaignBlock[];
}

/**
 * The starting points. Plain words, short sentences; the organizer edits every one.
 * `__EVENT__` is replaced by the chosen event id when the draft is created.
 */
export const CAMPAIGN_TEMPLATES: Record<CampaignTemplateKey, CampaignTemplate> = {
  EVENT_ANNOUNCEMENT: {
    key: 'EVENT_ANNOUNCEMENT',
    label: 'New event',
    description:
      'Tell your audience about a new event, with the date, the place and a Book button.',
    purpose: ConsentPurpose.ORGANIZER_UPDATES,
    needsEvent: true,
    subject: 'New event: {event}',
    previewText: 'Tickets are on sale now.',
    blocks: [
      { type: 'image', source: 'EVENT', alt: '{event}' },
      { type: 'heading', text: '{event}' },
      {
        type: 'paragraph',
        text: 'We have a new event, and you are among the first to hear. Tickets are on sale now.',
      },
      { type: 'event', eventId: '__EVENT__' },
    ],
  },
  EARLY_BIRD: {
    key: 'EARLY_BIRD',
    label: 'Early-bird tickets',
    description: 'Give the people who asked for early access a head start.',
    purpose: ConsentPurpose.EARLY_ACCESS,
    needsEvent: true,
    subject: 'Early access: {event}',
    previewText: 'Book before tickets go on general sale.',
    blocks: [
      { type: 'heading', text: 'Early access for you' },
      {
        type: 'paragraph',
        text: 'You asked to hear first. Book {event} now, before tickets go on general sale.',
      },
      { type: 'event', eventId: '__EVENT__' },
    ],
  },
  UPCOMING_SHOWS: {
    key: 'UPCOMING_SHOWS',
    label: 'Upcoming shows',
    description: 'A round-up of what is coming up next.',
    purpose: ConsentPurpose.ORGANIZER_UPDATES,
    needsEvent: false,
    subject: 'Coming up from {organizer}',
    previewText: 'Our next events, and how to book.',
    blocks: [
      { type: 'image', source: 'ORGANIZER_LOGO', alt: '{organizer}' },
      { type: 'heading', text: 'Coming up next' },
      { type: 'paragraph', text: 'Here is what we have planned. We hope to see you there.' },
    ],
  },
  OFFER: {
    key: 'OFFER',
    label: 'Special offer',
    description: 'Share a promo code with the people who agreed to get offers.',
    purpose: ConsentPurpose.OFFERS,
    needsEvent: true,
    subject: 'An offer for {event}',
    previewText: 'Use your code when you book.',
    blocks: [
      { type: 'heading', text: 'An offer for you' },
      { type: 'offer', text: 'Use this code when you book.', code: 'CODE' },
      { type: 'event', eventId: '__EVENT__' },
    ],
  },
  THANK_YOU: {
    key: 'THANK_YOU',
    label: 'Thank you',
    description: 'Thank your audience after an event, and point them to the next one.',
    purpose: ConsentPurpose.ORGANIZER_UPDATES,
    needsEvent: false,
    subject: 'Thank you from {organizer}',
    previewText: 'Thank you for coming.',
    blocks: [
      { type: 'heading', text: 'Thank you for coming' },
      {
        type: 'paragraph',
        text: 'Thank you for being part of it. We hope you had a great time, and we hope to see you again soon.',
      },
    ],
  },
};

/** The template's starting content, with the names filled in. */
export function templateStart(
  key: CampaignTemplateKey,
  names: { event?: { id: string; title: string } | null; organizer: string },
): { subject: string; previewText: string; purpose: OrganizerPurpose; content: CampaignContent } {
  const t = CAMPAIGN_TEMPLATES[key];
  const fill = (s: string) =>
    s
      .replace(/\{event\}/g, names.event?.title ?? 'our next event')
      .replace(/\{organizer\}/g, names.organizer);
  const blocks = t.blocks
    .filter((b) =>
      b.type === 'event' || (b.type === 'image' && b.source === 'EVENT') ? !!names.event : true,
    )
    .map((b): CampaignBlock => {
      if (b.type === 'event') return { ...b, eventId: names.event!.id };
      if (b.type === 'heading' || b.type === 'paragraph' || b.type === 'offer') {
        return { ...b, text: fill(b.text) };
      }
      if (b.type === 'image') return { ...b, alt: fill(b.alt) };
      return b;
    });
  return {
    subject: fill(t.subject).slice(0, 150),
    previewText: fill(t.previewText),
    purpose: t.purpose,
    content: {
      blocks: blocks.length ? blocks : [{ type: 'paragraph', text: fill(t.previewText) }],
    },
  };
}

/** The event ids a content refers to, for the ownership check. */
export function eventIdsIn(content: CampaignContent): string[] {
  return [...new Set(content.blocks.flatMap((b) => (b.type === 'event' ? [b.eventId] : [])))];
}

/** The button URLs a content carries, for the allowlist check. */
export function buttonUrlsIn(content: CampaignContent): string[] {
  return content.blocks.flatMap((b) => (b.type === 'button' ? [b.url] : []));
}
