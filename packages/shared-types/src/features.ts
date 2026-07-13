/**
 * Feature flags. Shipped capabilities default to `true`; unfinished enterprise
 * capabilities default to `false` and are surfaced only behind the flag (never
 * as dead code). A deployment can override any flag via an environment variable
 * named `FEATURE_<FLAG>` / `NEXT_PUBLIC_FEATURE_<FLAG>` (e.g. FEATURE_MEMBERSHIPS=1).
 */
export const FEATURE_DEFAULTS = {
  // Live, shipped features.
  savedEvents: true,
  reviews: true,
  organizerProfiles: true,
  eventFaq: true,
  experienceDiscovery: true,
  community: true,

  // Enterprise capabilities — placeholder architecture only, disabled by default.
  memberships: false,
  subscriptions: false,
  organizerCrm: false,
  marketingAutomation: false,
  dynamicPricing: false,
  whiteLabel: false,
  sponsors: false,
  eventTemplates: false,
  aiRecommendations: false,
} as const;

export type FeatureFlag = keyof typeof FEATURE_DEFAULTS;

const ENV_KEY: Record<FeatureFlag, string> = {
  savedEvents: 'SAVED_EVENTS',
  reviews: 'REVIEWS',
  organizerProfiles: 'ORGANIZER_PROFILES',
  eventFaq: 'EVENT_FAQ',
  experienceDiscovery: 'EXPERIENCE_DISCOVERY',
  community: 'COMMUNITY',
  memberships: 'MEMBERSHIPS',
  subscriptions: 'SUBSCRIPTIONS',
  organizerCrm: 'ORGANIZER_CRM',
  marketingAutomation: 'MARKETING_AUTOMATION',
  dynamicPricing: 'DYNAMIC_PRICING',
  whiteLabel: 'WHITE_LABEL',
  sponsors: 'SPONSORS',
  eventTemplates: 'EVENT_TEMPLATES',
  aiRecommendations: 'AI_RECOMMENDATIONS',
};

function readEnv(flag: FeatureFlag): boolean | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const key = ENV_KEY[flag];
  const raw = process.env[`FEATURE_${key}`] ?? process.env[`NEXT_PUBLIC_FEATURE_${key}`];
  if (raw === undefined) return undefined;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/** Resolves a feature flag, preferring an env override over the default. */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return readEnv(flag) ?? FEATURE_DEFAULTS[flag];
}

/** Enterprise capabilities shown as "coming soon" placeholders when enabled. */
export const ENTERPRISE_FEATURES: {
  flag: FeatureFlag;
  title: string;
  description: string;
}[] = [
  {
    flag: 'memberships',
    title: 'Memberships',
    description: 'Recurring member tiers with perks and presale access.',
  },
  {
    flag: 'subscriptions',
    title: 'Subscriptions',
    description: 'Season passes and subscription bundles for repeat attendees.',
  },
  {
    flag: 'organizerCrm',
    title: 'Organizer CRM',
    description: 'Segment attendees, track lifetime value, and manage relationships.',
  },
  {
    flag: 'marketingAutomation',
    title: 'Marketing automation',
    description: 'Automated email/SMS journeys triggered by attendee behaviour.',
  },
  {
    flag: 'dynamicPricing',
    title: 'Dynamic pricing',
    description: 'Demand-based pricing rules that adjust ticket prices automatically.',
  },
  {
    flag: 'whiteLabel',
    title: 'White-label',
    description: 'Run the platform under your own brand and domain.',
  },
  {
    flag: 'sponsors',
    title: 'Sponsor management',
    description: 'Sponsor packages, booths, assets, benefits, invoices and reports.',
  },
  {
    flag: 'eventTemplates',
    title: 'Experience templates',
    description: 'One-click templates preconfiguring tickets, forms, emails and reports.',
  },
  {
    flag: 'aiRecommendations',
    title: 'AI recommendations',
    description: 'Personalised discovery and organizer copilot powered by ranking models.',
  },
];
