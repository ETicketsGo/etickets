// Experience Wallet Platform (ADR-033). A generic wallet where a Ticket is just
// one WalletItem. Providers register per item-type and normalize their source to
// a common WalletItem shape, so the wallet UI never depends on Ticket (or any
// concrete type) and there are no per-type switch statements. Pure + framework-
// free: directly unit-testable and shared by every app.
//
// The CTO's ExperienceAsset lifecycle (view/share/transfer/archive/expire/notify)
// is expressed through each item's capability set, so every future asset —
// memberships, parking, coupons, merchandise, collectibles — plugs in the same way.

import type { WalletTicket } from './api';
import { groupWalletTickets, type BookingGroup, type GroupStatusTone } from './tickets';
import { eventTiming } from './event-timing';

export type WalletItemType =
  'TICKET' | 'MEMBERSHIP' | 'PARKING' | 'COUPON' | 'MERCHANDISE' | 'REWARD';

/** Lifecycle + action capabilities an item can declare (superset; items pick). */
export type WalletCapability =
  | 'view'
  | 'share'
  | 'assign'
  | 'transfer'
  | 'download'
  | 'walletPass'
  | 'directions'
  | 'parking'
  | 'support'
  | 'favorite'
  | 'archive'
  | 'remove'
  | 'renew'
  | 'checkIn';

/** Wallet home sections (feature-flagged; an item can belong to several). */
export type WalletSection =
  | 'today'
  | 'upcoming'
  | 'active'
  | 'memberships'
  | 'parking'
  | 'coupons'
  | 'rewards'
  | 'completed'
  | 'cancelled';

/** Filter tags an item is matched against by the filter strategy. */
export type WalletFilter =
  | 'tickets'
  | 'movies'
  | 'events'
  | 'memberships'
  | 'parking'
  | 'coupons'
  | 'merchandise'
  | 'rewards'
  | 'shared'
  | 'assigned'
  | 'active'
  | 'expired';

export interface WalletActionRef {
  label: string;
  href?: string;
  /** A named client action when there's no href (e.g. "preview"). */
  action?: string;
}

/**
 * The normalized shape every wallet item exposes. The renderer draws only from
 * these fields — no item-type branching. `icon`/`accent` are renderer-agnostic
 * hints. `capabilities` doubles as the ExperienceAsset lifecycle surface.
 */
export interface WalletItem {
  id: string;
  type: WalletItemType;
  title: string;
  subtitle: string | null;
  status: string;
  statusTone: GroupStatusTone;
  badge: string | null;
  icon: WalletItemType;
  artworkSeed: string;
  startsAt: string | null;
  expiresAt: string | null;
  reference: string | null;
  sections: WalletSection[];
  filters: WalletFilter[];
  /** Keys for pluggable grouping strategies (booking/event/venue/date/status/type). */
  groupKeys: Record<string, string>;
  /** Lowercased search haystack. */
  searchText: string;
  capabilities: WalletCapability[];
  primaryAction: WalletActionRef;
  secondaryActions: WalletActionRef[];
  progress: { done: number; total: number; label: string } | null;
  metadata: { label: string; value: string }[];
}

/** ExperienceAsset lifecycle view of a wallet item (CTO abstraction). */
export interface ExperienceAssetCapabilities {
  canView: boolean;
  canShare: boolean;
  canTransfer: boolean;
  canArchive: boolean;
  canExpire: boolean;
  canNotify: boolean;
}
export function assetCapabilities(item: WalletItem): ExperienceAssetCapabilities {
  const has = (c: WalletCapability) => item.capabilities.includes(c);
  return {
    canView: has('view'),
    canShare: has('share'),
    canTransfer: has('transfer'),
    canArchive: has('archive'),
    canExpire: item.expiresAt != null,
    canNotify: true,
  };
}

/** Feature flags gate which providers contribute (placeholders are OFF by default). */
export interface WalletFlags {
  memberships: boolean;
  parking: boolean;
  coupons: boolean;
  merchandise: boolean;
  rewards: boolean;
}
export const DEFAULT_WALLET_FLAGS: WalletFlags = {
  memberships: false,
  parking: false,
  coupons: false,
  merchandise: false,
  rewards: false,
};

/** Everything a provider might read to build its items. */
export interface WalletSources {
  tickets: WalletTicket[];
}

/**
 * A wallet provider contributes items of one type. Providers register in
 * WALLET_PROVIDERS; the registry never switches on type. `enabled` gates on flags
 * (real providers are always on; placeholders default off).
 */
export interface WalletProvider {
  type: WalletItemType;
  enabled(flags: WalletFlags): boolean;
  build(sources: WalletSources): WalletItem[];
}

// ─────────────────────────── Ticket provider ───────────────────────────

function ticketGroupToItem(group: BookingGroup): WalletItem {
  const t = eventTiming(group.startsAt, Date.now());
  const active = group.counts.active > 0;
  const allDone = group.counts.total > 0 && group.counts.checkedIn === group.counts.total;
  const cancelled =
    group.counts.total > 0 &&
    group.counts.active + group.counts.checkedIn + group.counts.transferred === 0;

  const sections: WalletSection[] = [];
  if (cancelled) sections.push('cancelled');
  else if (t.phase === 'ended' || allDone) sections.push('completed');
  else if (t.isEventDay) sections.push('today');
  else sections.push('upcoming');
  if (active && !cancelled) sections.push('active');

  const filters: WalletFilter[] = ['tickets', group.isMovie ? 'movies' : 'events'];
  if (active) filters.push('active');
  if (group.counts.transferred > 0) filters.push('transferred' as WalletFilter);

  const single = group.counts.total === 1;
  const countLabel = `${group.counts.total} ${single ? 'ticket' : 'tickets'}`;
  const place = group.isMovie
    ? [group.cinemaName, group.screenName].filter(Boolean).join(' · ')
    : group.venueName;

  return {
    id: `ticket:${group.bookingId}`,
    type: 'TICKET',
    title: group.title,
    subtitle: `${countLabel} · ${group.bookingRef}`,
    status: group.summary,
    statusTone: group.statusTone,
    badge: group.isMovie ? 'Movie' : 'Event',
    icon: 'TICKET',
    artworkSeed: group.bookingId,
    startsAt: group.startsAt,
    expiresAt: null,
    reference: group.bookingRef,
    sections,
    filters,
    groupKeys: {
      booking: group.bookingId,
      event: group.title,
      venue: group.venueName ?? '—',
      date: group.startsAt.slice(0, 10),
      status: group.statusTone,
      type: 'TICKET',
    },
    searchText: [
      group.title,
      group.bookingRef,
      group.venueName,
      group.screenName,
      group.cinemaName,
      group.ticketTypeSummary,
      group.seatLabels.join(' '),
      place,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
    capabilities: [
      'view',
      'share',
      'assign',
      'transfer',
      'download',
      'walletPass',
      'directions',
      'support',
      ...(active ? (['checkIn'] as WalletCapability[]) : []),
    ],
    primaryAction: {
      label: single ? 'View ticket' : 'View tickets',
      href: `/account/bookings/${encodeURIComponent(group.bookingId)}/tickets`,
    },
    secondaryActions: [],
    progress:
      group.counts.total > 1
        ? { done: group.counts.checkedIn, total: group.counts.total, label: group.checkInProgress }
        : null,
    metadata: [
      ...(place ? [{ label: 'Where', value: place }] : []),
      { label: 'Reference', value: group.bookingRef },
    ],
  };
}

export const ticketWalletProvider: WalletProvider = {
  type: 'TICKET',
  enabled: () => true,
  build: (sources) => groupWalletTickets(sources.tickets).map(ticketGroupToItem),
};

// ─────────────────── Placeholder providers (mock, flag-gated) ───────────────────
// Real WalletItem implementations with NO backend business logic — they prove the
// architecture end-to-end so Sprint-6+ product work is a drop-in, not a redesign.

function mockItem(
  type: WalletItemType,
  over: Partial<WalletItem> & { id: string; title: string },
): WalletItem {
  return {
    type,
    subtitle: null,
    status: 'Preview',
    statusTone: 'neutral',
    badge: 'Preview',
    icon: type,
    artworkSeed: over.id,
    startsAt: null,
    expiresAt: null,
    reference: null,
    sections: [],
    filters: [],
    groupKeys: { type },
    searchText: over.title.toLowerCase(),
    capabilities: ['view', 'share', 'archive'],
    primaryAction: { label: 'Preview', action: 'preview' },
    secondaryActions: [],
    progress: null,
    metadata: [],
    ...over,
  };
}

export const membershipWalletProvider: WalletProvider = {
  type: 'MEMBERSHIP',
  enabled: (f) => f.memberships,
  build: () => [
    mockItem('MEMBERSHIP', {
      id: 'membership:gold',
      title: 'ETicketsGo Gold',
      subtitle: 'Annual membership · Preview',
      status: 'Active',
      statusTone: 'success',
      sections: ['memberships'],
      filters: ['memberships'],
      capabilities: ['view', 'share', 'renew', 'archive'],
      expiresAt: '2027-01-01T00:00:00.000Z',
      metadata: [{ label: 'Tier', value: 'Gold' }],
    }),
  ],
};

export const parkingWalletProvider: WalletProvider = {
  type: 'PARKING',
  enabled: (f) => f.parking,
  build: () => [
    mockItem('PARKING', {
      id: 'parking:demo',
      title: 'Venue Parking Pass',
      subtitle: 'Lot B · Preview',
      status: 'Ready',
      statusTone: 'info',
      sections: ['parking'],
      filters: ['parking'],
      capabilities: ['view', 'directions', 'archive'],
    }),
  ],
};

export const couponWalletProvider: WalletProvider = {
  type: 'COUPON',
  enabled: (f) => f.coupons,
  build: () => [
    mockItem('COUPON', {
      id: 'coupon:welcome',
      title: '10% Welcome Coupon',
      subtitle: 'Code WELCOME10 · Preview',
      status: 'Available',
      statusTone: 'success',
      sections: ['coupons'],
      filters: ['coupons'],
      capabilities: ['view', 'share', 'archive'],
      expiresAt: '2026-12-31T00:00:00.000Z',
    }),
  ],
};

/** The registry. New wallet items append here — no other code changes. */
export const WALLET_PROVIDERS: WalletProvider[] = [
  ticketWalletProvider,
  membershipWalletProvider,
  parkingWalletProvider,
  couponWalletProvider,
];

/** Builds the full wallet from all enabled providers (no type switches). */
export function buildWallet(
  sources: WalletSources,
  flags: WalletFlags = DEFAULT_WALLET_FLAGS,
): WalletItem[] {
  return WALLET_PROVIDERS.filter((p) => p.enabled(flags)).flatMap((p) => p.build(sources));
}

// ─────────────────────────── Strategies ───────────────────────────

export function searchWallet(items: WalletItem[], query: string): WalletItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.searchText.includes(q));
}

export function filterWallet(items: WalletItem[], active: WalletFilter[]): WalletItem[] {
  if (active.length === 0) return items;
  return items.filter((i) => active.some((f) => i.filters.includes(f)));
}

export type WalletSort = 'soonest' | 'recent' | 'title';
export function sortWallet(items: WalletItem[], sort: WalletSort): WalletItem[] {
  const copy = [...items];
  if (sort === 'title') return copy.sort((a, b) => a.title.localeCompare(b.title));
  const time = (i: WalletItem) => (i.startsAt ? new Date(i.startsAt).getTime() : 0);
  if (sort === 'soonest') return copy.sort((a, b) => (time(a) || Infinity) - (time(b) || Infinity));
  return copy.sort((a, b) => time(b) - time(a)); // recent
}

export type WalletGroupBy = 'booking' | 'event' | 'venue' | 'date' | 'status' | 'type';
export interface WalletGroup {
  key: string;
  items: WalletItem[];
}
export function groupWallet(items: WalletItem[], by: WalletGroupBy): WalletGroup[] {
  const order: string[] = [];
  const map = new Map<string, WalletItem[]>();
  for (const i of items) {
    const key = i.groupKeys[by] ?? '—';
    const bucket = map.get(key);
    if (bucket) bucket.push(i);
    else {
      map.set(key, [i]);
      order.push(key);
    }
  }
  return order.map((key) => ({ key, items: map.get(key)! }));
}

export const WALLET_SECTION_ORDER: WalletSection[] = [
  'today',
  'active',
  'upcoming',
  'memberships',
  'parking',
  'coupons',
  'rewards',
  'completed',
  'cancelled',
];
export const WALLET_SECTION_LABELS: Record<WalletSection, string> = {
  today: 'Today',
  active: 'Active',
  upcoming: 'Upcoming',
  memberships: 'Memberships',
  parking: 'Parking',
  coupons: 'Coupons',
  rewards: 'Rewards',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * Buckets items into ordered sections. An item may appear in several sections; to
 * keep the wallet uncluttered each item is placed once, in its highest-priority
 * section per WALLET_SECTION_ORDER.
 */
export function sectionizeWallet(items: WalletItem[]): WalletGroup[] {
  const buckets = new Map<WalletSection, WalletItem[]>();
  for (const item of items) {
    const section = WALLET_SECTION_ORDER.find((s) => item.sections.includes(s));
    if (!section) continue;
    const bucket = buckets.get(section);
    if (bucket) bucket.push(item);
    else buckets.set(section, [item]);
  }
  return WALLET_SECTION_ORDER.filter((s) => buckets.has(s)).map((s) => ({
    key: s,
    items: buckets.get(s)!,
  }));
}
