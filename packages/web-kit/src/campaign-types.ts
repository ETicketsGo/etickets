/**
 * Response shapes of the organizer campaign API, as the consoles read them.
 *   organizer: /organizations/:id/campaigns/*
 *   admin:     /admin/campaigns/*
 * Nothing here holds a recipient or an address: the API never returns one.
 */

export type CampaignStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'PENDING_APPROVAL'
  | 'QUEUED'
  | 'SENDING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'PARTIALLY_FAILED'
  | 'FAILED'
  | 'CANCELLED';

export type CampaignPurpose = 'ORGANIZER_UPDATES' | 'EARLY_ACCESS' | 'OFFERS';
export type CampaignTemplateKey =
  'EVENT_ANNOUNCEMENT' | 'EARLY_BIRD' | 'UPCOMING_SHOWS' | 'OFFER' | 'THANK_YOU';
export type AudienceSource = 'FOLLOWERS' | 'REPEAT_BUYERS' | 'EARLY_ACCESS' | 'EVENT_BUYERS';

export type CampaignBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'image'; source: 'EVENT' | 'ORGANIZER_LOGO'; alt: string }
  | { type: 'button'; label: string; url: string }
  | { type: 'event'; eventId: string }
  | { type: 'offer'; text: string; code?: string }
  | { type: 'divider' };

export interface CampaignAudienceDefinition {
  sources: AudienceSource[];
  eventIds?: string[];
  cities?: string[];
  savedSegmentId?: string;
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface Campaign {
  id: string;
  organizationId: string;
  name: string;
  subject: string;
  previewText: string | null;
  senderName: string;
  replyTo: string | null;
  purpose: CampaignPurpose;
  templateKey: CampaignTemplateKey;
  content: { blocks: CampaignBlock[] };
  eventId: string | null;
  audience: CampaignAudienceDefinition;
  status: CampaignStatus;
  scheduledAt: string | null;
  timezone: string;
  quietHours: QuietHours | null;
  locale: 'en' | 'fr-CA';
  version: number;
  counters: Partial<Record<string, number>> | null;
  pausedReason: string | null;
  failureReason: string | null;
  confirmedAt: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignTemplateInfo {
  key: CampaignTemplateKey;
  label: string;
  description: string;
  purpose: CampaignPurpose;
  needsEvent: boolean;
}

export interface CampaignsStatus {
  enabled: boolean;
  planCode: string;
  sending: {
    allowed: boolean;
    mode: 'DEDICATED_MARKETING' | 'SHARED_TRANSACTIONAL' | 'LOG_ONLY' | null;
    refusal: string | null;
  };
  entitlements: {
    create: boolean;
    schedule: boolean;
    analyticsBasic: boolean;
    analyticsAdvanced: boolean;
    audienceAdvanced: boolean;
  };
  quota: {
    periodKey: string;
    quota: number;
    used: number;
    credits: number;
    remaining: number;
  } | null;
  defaults: { quietHours: QuietHours };
  templates: CampaignTemplateInfo[];
}

export interface AudiencePreview {
  matched: number;
  eligible: number;
  noConsent: number;
  suppressedGlobal: number;
  suppressedOrganizer: number;
  estimatedCredits: number;
  quotaRemaining: number;
  enoughQuota: boolean;
}

export interface CampaignReview {
  campaign: Campaign;
  audience: AudiencePreview | null;
  sendingMode: CampaignsStatus['sending']['mode'];
  quietHoursNow: boolean;
  nextSendableAt: string;
  canSchedule: boolean;
  problems: string[];
  confirmationToken: string | null;
}

export interface CampaignPreview {
  subject: string;
  previewText: string | null;
  html: string;
  text: string;
}

export interface CurrencyAttribution {
  currency: string;
  orders: number;
  ticketRevenueMinor: number;
  revenuePerDeliveredMinor?: number | null;
}

export interface CampaignStats {
  campaignId: string;
  targeted: number;
  eligible: number;
  skippedConsent: number;
  skippedSuppressed: number;
  pending: number;
  accepted: number;
  delivered: number;
  deferred: number;
  bounced: number;
  complained: number;
  failed: number;
  unsubscribed: number;
  uniqueClicks: number;
  clickRate: number | null;
  attribution: {
    windowDays: number;
    model: 'LAST_CLICK';
    byCurrency: CurrencyAttribution[];
  } | null;
  attributionLocked: boolean;
}

export interface CampaignHistoryItem {
  id: string;
  type: string;
  actorUserId: string | null;
  detail: Record<string, unknown> | null;
  occurredAt: string;
}

export interface SavedSegment {
  id: string;
  name: string;
  definition: Omit<CampaignAudienceDefinition, 'savedSegmentId'>;
  createdAt: string;
  updatedAt: string;
}

export interface SeriesPoint {
  start: string;
  count: number;
}

export interface CampaignAnalyticsOverview {
  organizationId: string;
  range: { from: string; to: string; unit: 'day' | 'week' };
  threshold: number;
  followers: {
    total: number;
    newInRange: number;
    bySource: { source: string; followers: number }[];
    series: SeriesPoint[];
  };
  subscribers: { purpose: CampaignPurpose; subscribers: number }[];
  optInRate: number | null;
  buyers: { buyers: number; returningCustomers: number; repeatBuyerRate: number | null };
  unsubscribes: { total: number; series: SeriesPoint[] };
  cities: {
    buckets: { city: string; country: string | null; buyers: number }[];
    hiddenBuckets: number;
    threshold: number;
  };
  categories: {
    buckets: { category: string; buyers: number }[];
    hiddenBuckets: number;
    threshold: number;
  };
  campaigns: {
    items: {
      id: string;
      name: string;
      status: CampaignStatus;
      startedAt: string | null;
      targeted: number;
      delivered: number;
      bounced: number;
      complained: number;
      unsubscribed: number;
      uniqueClicks: number;
      clickRate: number | null;
      attributed: CurrencyAttribution[] | null;
    }[];
    attributionLocked: boolean;
    windowDays: number;
  };
}

export interface CampaignDraftBody {
  name?: string;
  subject?: string;
  previewText?: string | null;
  senderName?: string;
  replyTo?: string | null;
  purpose?: CampaignPurpose;
  templateKey?: CampaignTemplateKey;
  content?: { blocks: CampaignBlock[] };
  eventId?: string | null;
  audience?: CampaignAudienceDefinition;
  timezone?: string;
  quietHours?: QuietHours | null;
  locale?: 'en' | 'fr-CA';
}

export interface AdminCampaignRow {
  id: string;
  organizationId: string;
  organizationName: string | null;
  name: string;
  subject: string;
  purpose: string;
  status: CampaignStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pausedReason: string | null;
  counters: Partial<Record<string, number>> | null;
  createdAt: string;
}

export interface CampaignSendingHealth {
  windows: {
    days: number;
    accepted: number;
    bounced: number;
    complained: number;
    bounceRate: number | null;
    complaintRate: number | null;
  }[];
  thresholds: { bounceRate: number; complaintRate: number };
  campaignsInFlight: number;
  generatedAt: string;
}
