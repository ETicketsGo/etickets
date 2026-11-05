import type {
  AudienceSource,
  CampaignBlock,
  CampaignPurpose,
  CampaignStatus,
  CampaignsStatus,
} from '@eticketsgo/web-kit';

/**
 * The words and the small rules of the campaign pages, kept out of the components so they
 * can be tested without a browser. Plain English, short sentences.
 */

export type ChipTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export const STATUS_WORDS: Record<CampaignStatus, { label: string; tone: ChipTone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SCHEDULED: { label: 'Scheduled', tone: 'info' },
  PENDING_APPROVAL: { label: 'Waiting for review', tone: 'warning' },
  QUEUED: { label: 'Starting', tone: 'info' },
  SENDING: { label: 'Sending', tone: 'info' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  COMPLETED: { label: 'Sent', tone: 'success' },
  PARTIALLY_FAILED: { label: 'Sent, some failed', tone: 'warning' },
  FAILED: { label: 'Failed', tone: 'error' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

/** The filter chips on the list, in the order a person thinks about them. */
export const STATUS_FILTERS: { value: CampaignStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'SENDING', label: 'Sending' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'COMPLETED', label: 'Sent' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export const PURPOSE_WORDS: Record<CampaignPurpose, { label: string; hint: string }> = {
  ORGANIZER_UPDATES: {
    label: 'Event news',
    hint: 'New events and updates. Goes to people who agreed to get your event news.',
  },
  EARLY_ACCESS: {
    label: 'Early access',
    hint: 'Presales and early-bird tickets. Goes to people who asked for early access.',
  },
  OFFERS: {
    label: 'Offers',
    hint: 'Discounts and promo codes. Goes to people who agreed to get offers.',
  },
};

export const SOURCE_WORDS: Record<AudienceSource, { label: string; hint: string }> = {
  FOLLOWERS: { label: 'Followers', hint: 'People who follow you.' },
  REPEAT_BUYERS: { label: 'Repeat buyers', hint: 'People who booked with you 2 or more times.' },
  EARLY_ACCESS: { label: 'Early-access sign-ups', hint: 'People who asked for early access.' },
  EVENT_BUYERS: { label: 'People who booked an event', hint: 'Choose one or more of your events.' },
};

export const BUILDER_STEPS = ['Setup', 'Audience', 'Design', 'Schedule', 'Review'] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number];

/** Why a paused campaign is paused, for a person. */
export function pausedReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === 'ORGANIZER') return 'You paused this campaign.';
  if (reason === 'ADMIN') return 'ETicketsGo paused this campaign. Contact support to continue.';
  if (reason === 'QUOTA_EXHAUSTED') {
    return 'Paused because your plan has no emails left this month. Add credits or wait for next month, then resume.';
  }
  if (reason.startsWith('PROVIDER_REFUSED')) {
    return 'Paused because the email service refused to send. We are looking into it.';
  }
  return 'This campaign is paused.';
}

export type Gate =
  | { kind: 'ready' }
  | { kind: 'off'; title: string; hint: string }
  | { kind: 'plan'; title: string; hint: string };

/**
 * What the campaign pages may show. Never a dead button: when campaigns are off here or the
 * plan does not include them, the page says so and links to Billing & plans instead.
 */
export function campaignGate(status: CampaignsStatus | undefined): Gate {
  if (!status)
    return {
      kind: 'off',
      title: 'Email campaigns are not available',
      hint: 'Please try again later.',
    };
  if (!status.enabled) {
    return {
      kind: 'off',
      title: 'Email campaigns are coming soon',
      hint: 'Email campaigns are not switched on yet. We will tell you when they are.',
    };
  }
  if (!status.entitlements.create) {
    return {
      kind: 'plan',
      title: 'Email campaigns are part of the Pro and Premium plans',
      hint: 'Upgrade your plan to send email campaigns to the people who agreed to hear from you.',
    };
  }
  return { kind: 'ready' };
}

/** "12.5%" or a dash. */
export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

/** Problems with the Setup step, or an empty list. */
export function setupProblems(d: {
  name?: string;
  subject?: string;
  senderName?: string;
}): string[] {
  const out: string[] = [];
  if (!d.name?.trim()) out.push('Give the campaign a name.');
  if (!d.subject?.trim()) out.push('Write a subject line.');
  if ((d.subject ?? '').length > 150) out.push('Keep the subject line under 150 characters.');
  if (!d.senderName?.trim()) out.push('Write the sender name people will see.');
  return out;
}

/** Problems with the Audience step. */
export function audienceProblems(a: { sources: AudienceSource[]; eventIds?: string[] }): string[] {
  const out: string[] = [];
  if (a.sources.length === 0) out.push('Choose at least one group of people.');
  if (a.sources.includes('EVENT_BUYERS') && !(a.eventIds?.length ?? 0)) {
    out.push('Choose at least one event for "People who booked an event".');
  }
  return out;
}

/** Problems with the Design step. Text only: the API checks links against our own hosts. */
export function designProblems(blocks: CampaignBlock[]): string[] {
  const out: string[] = [];
  if (blocks.length === 0) out.push('Add at least one block to the email.');
  for (const b of blocks) {
    if ((b.type === 'heading' || b.type === 'paragraph') && !b.text.trim()) {
      out.push('Fill in or remove the empty text blocks.');
      break;
    }
    if (b.type === 'button' && (!b.label.trim() || !/^https:\/\//.test(b.url.trim()))) {
      out.push('Each button needs words and a link that starts with https://.');
      break;
    }
  }
  return out;
}

/**
 * The UTC instant for a wall-clock time in a time zone ("2026-10-28T19:30" in Asia/Kolkata).
 * Uses the zone's own rules via Intl, so it is right across daylight-saving changes.
 */
export function zonedLocalToIso(local: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) - t;
  };
  try {
    let t = asUtc - offsetAt(asUtc);
    t = asUtc - offsetAt(t);
    return new Date(t).toISOString();
  } catch {
    return null;
  }
}

/** A starting set of blocks when the organizer adds one from the palette. */
export function newBlock(
  type: CampaignBlock['type'],
  eventId?: string | null,
): CampaignBlock | null {
  switch (type) {
    case 'heading':
      return { type, text: 'A heading' };
    case 'paragraph':
      return { type, text: 'Write your message here.' };
    case 'button':
      return { type, label: 'Find out more', url: 'https://eticketsgo.com/' };
    case 'offer':
      return { type, text: 'Use this code when you book.', code: 'CODE' };
    case 'divider':
      return { type };
    case 'image':
      return { type, source: eventId ? 'EVENT' : 'ORGANIZER_LOGO', alt: 'Image' };
    case 'event':
      return eventId ? { type, eventId } : null;
    default:
      return null;
  }
}

/** Common IANA zones for the picker; the browser's own zone is added first by the page. */
export const COMMON_TIME_ZONES = [
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'UTC',
];
