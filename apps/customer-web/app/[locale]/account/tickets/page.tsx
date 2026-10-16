'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { RefreshCw, Search, Trash2, WifiOff } from 'lucide-react';
import {
  BrandButton,
  brandButtonClasses,
  brandChipClasses,
  buildWallet,
  filterWallet,
  searchWallet,
  sectionizeWallet,
  summarizeBookingGroup,
  useConnectivity,
  useToast,
  DEFAULT_WALLET_FLAGS,
  WALLET_SECTION_LABELS,
  BRAND_FOCUS as brandFocus,
  type GroupSummaryWords,
  type WalletFilter,
  type WalletFlags,
  type WalletItem,
  type WalletLabels,
} from '@eticketsgo/web-kit';
import { tokenStore } from '@/lib/api';
import { WalletCard } from '@/components/wallet-card';
import { BRAND_FIELD } from '@/components/booking-brand';
import { Placeholder } from '@/components/home/parts';
import { BrandEmpty, BrandPage } from '@/components/storefront-brand';
import { Link } from '@/i18n/navigation';
import { fetchWalletWithOffline, lastSyncedAt, deriveSyncState } from '@/lib/offline/sync';
import { clearAllOffline } from '@/lib/offline/wallet-store';
import { requestWalletSync } from '@/lib/push';
import { useTranslations } from 'next-intl';
import { useMounted } from '@/lib/use-mounted';

/*
  ── MY TICKETS ON THE BRAND LAYER (docs/design/DESIGN-SYSTEM.md) ───────────────────────
  The wallet was the last account page a buyer opens often that still wore the old system:
  gradient tiles, blue buttons and a shadowed white box for the sync line. It now matches the
  confirmation page a buyer arrives from: paper, ink, the display face for titles, status as
  words in pills, and each booking as a ticket stub with its date on the venue's calendar.
  The same items, search, filters, sections and sync controls as before.
*/

/** A quiet text button for the sync line: a 44px target on a phone, compact from `sm`. */
const SYNC_BUTTON =
  'inline-flex min-h-11 items-center gap-1.5 rounded-brand-control px-2 font-semibold text-brand-ink hover:bg-brand-surface disabled:pointer-events-none disabled:opacity-50 sm:min-h-9';

/** The wallet messages' translator, in the shape `formatSynced` takes it. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

function formatSynced(ts: number | null, w: Translate): string {
  if (!ts) return w('syncedNever');
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return w('syncedJustNow');
  if (mins < 60) return w('syncedMinutes', { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return w('syncedHours', { count: hrs });
  return w('syncedDays', { count: Math.round(hrs / 24) });
}

/*
  The chips offered, in order. Their words come from `storefront.wallet.filter`: they were
  hardcoded English, so /fr-CA/account/tickets showed "Movies", "Events" and "Active" (QA, and
  the French no-English e2e sweep), along with the English sync status beside them.
*/
const FILTER_CHIPS: WalletFilter[] = [
  'movies',
  'events',
  'active',
  'memberships',
  'coupons',
  'parking',
];

/** Reads placeholder wallet feature flags from `?preview=memberships,coupons`. */
function readFlags(): WalletFlags {
  if (typeof window === 'undefined') return DEFAULT_WALLET_FLAGS;
  const preview = new URLSearchParams(window.location.search).get('preview') ?? '';
  const on = new Set(preview.split(',').map((s) => s.trim().toLowerCase()));
  return {
    memberships: on.has('memberships'),
    parking: on.has('parking'),
    coupons: on.has('coupons'),
    merchandise: on.has('merchandise'),
    rewards: on.has('rewards'),
  };
}

export default function ExperienceWalletPage() {
  const w = useTranslations('storefront.wallet');
  const tc = useTranslations('common');
  const mounted = useMounted();
  const router = useRouter();
  const toast = useToast();
  const [flags, setFlags] = useState<WalletFlags>(DEFAULT_WALLET_FLAGS);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<WalletFilter[]>([]);

  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account/tickets');
    setFlags(readFlags());
  }, [router]);

  // Connectivity is derived from the browser hint AND real API-origin reachability, so the offline
  // indicator is correct even when navigator.onLine is stale (e.g. after an offline reload). Treat
  // ONLINE/UNKNOWN as "online" for affordances; OFFLINE/DEGRADED disable sync + show the offline icon.
  const connectivity = useConnectivity();
  const online = connectivity.state === 'ONLINE' || connectivity.state === 'UNKNOWN';
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['wallet'],
    queryFn: fetchWalletWithOffline,
    // Not `typeof window`, which differs between server and first client render. See useMounted.
    enabled: mounted && !!tokenStore.access,
  });
  // Track the last successful sync time for the "Updated …" label.
  useEffect(() => {
    lastSyncedAt().then(setSyncedAt);
  }, [data]);

  // Background sync (WS8): register a wallet-sync tag and refetch when the service
  // worker signals SYNC_WALLET (fired on the browser's `sync` event after reconnect).
  useEffect(() => {
    void requestWalletSync();
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'SYNC_WALLET') refetch();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [refetch]);

  const syncState = deriveSyncState({
    // The same mounted gate, so the status line reads the same on the server and at hydration.
    hasToken: mounted && !!tokenStore.access,
    connectivity: connectivity.state,
    isFetching,
    hasData: !!data && data.length > 0,
    isError,
  });

  const clearOffline = async () => {
    await clearAllOffline();
    toast.push(w('offlineCleared'), 'success');
  };

  /*
    The card words in the reader's language. web-kit builds the wallet items and used to write
    "2 tickets", "Event", "View tickets" and "1 of 2 checked in" into them in English; it now
    takes the words, and decides only which ones apply.
  */
  const b = useTranslations('storefront.bookingTickets');
  const wc = useTranslations('storefront.walletCard');
  const labels = useMemo<WalletLabels>(() => {
    const words: GroupSummaryWords = {
      allCheckedIn: wc('allCheckedIn'),
      bookingCancelled: wc('bookingCancelled'),
      segment: (kind, count) => wc(`segment.${kind}`, { count }),
    };
    return {
      ticketCount: (count) => b('ticketCount', { count }),
      badge: (isMovie) => wc(isMovie ? 'badgeMovie' : 'badgeEvent'),
      viewTickets: (count) => wc(count === 1 ? 'viewTicket' : 'viewTickets'),
      summary: (counts) => summarizeBookingGroup(counts, words).summary,
      checkInProgress: (checkedIn, total) => b('checkInProgress', { checkedIn, total }),
      where: wc('where'),
      reference: wc('reference'),
    };
  }, [b, wc]);

  // Build the generic wallet, then apply search + filters, then sectionize.
  const items = useMemo(
    () => (data ? buildWallet({ tickets: data, labels }, flags) : []),
    [data, flags, labels],
  );
  const availableFilters = useMemo(() => {
    const present = new Set(items.flatMap((i) => i.filters));
    return FILTER_CHIPS.filter((c) => present.has(c));
  }, [items]);
  const sections = useMemo(
    () => sectionizeWallet(filterWallet(searchWallet(items, q), active)),
    [items, q, active],
  );

  const toggle = (f: WalletFilter) =>
    setActive((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  const preview = (item: WalletItem) =>
    toast.push(w('previewToast', { title: item.title }), 'info');

  /** A section heading in the reader's language; web-kit's English label for one it does not name. */
  const sectionLabel = (key: string) =>
    w.has(`section.${key}`)
      ? w(`section.${key}`)
      : WALLET_SECTION_LABELS[key as keyof typeof WALLET_SECTION_LABELS];

  return (
    <BrandPage>
      <div className="mx-auto max-w-5xl space-y-6 px-4 pt-6 sm:px-6 sm:pt-10 lg:px-10">
        <div>
          <h1 className="font-brand-display text-brand-d1 text-brand-ink">{w('heading')}</h1>
          <p className="mt-2 max-w-prose text-brand-lead text-brand-ink-2">{w('lead')}</p>
        </div>

        {/* Offline / sync status - announced to assistive tech, never colour-only */}
        <div
          role="status"
          aria-live="polite"
          className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-brand-card px-4 py-2 text-brand-meta ${
            online ? 'bg-brand-sunken text-brand-ink-2' : 'bg-brand-caution-tint text-brand-caution'
          }`}
        >
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
            {!online && <WifiOff className="h-4 w-4" aria-hidden />}
            <span className="font-semibold">{w(`sync.${syncState}`)}</span>
            <span className={online ? 'text-brand-ink-3' : ''}>
              {w('updated', { when: formatSynced(syncedAt, w) })}
            </span>
          </span>
          <span className="-mx-2 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={!online || isFetching}
              className={`${SYNC_BUTTON} ${brandFocus}`}
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} aria-hidden />
              {w('syncNow')}
            </button>
            <button
              type="button"
              onClick={clearOffline}
              className={`${SYNC_BUTTON} font-medium text-brand-ink-2 ${brandFocus}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden /> {w('clearOffline')}
            </button>
          </span>
        </div>

        {syncState === 'REQUIRES_SIGN_IN' && mounted && !data ? (
          // The session ended after the page opened (a refresh that failed clears the tokens), so
          // the mount-time redirect above never ran. "Try again" cannot help here; signing in can.
          <BrandEmpty
            title={w('signInTitle')}
            hint={w('signInDescription')}
            action={
              <Link
                href="/login?next=/account/tickets"
                className={brandButtonClasses('primary', 'md')}
              >
                {w('signIn')}
              </Link>
            }
          />
        ) : isError && !data ? (
          <BrandEmpty
            title={w('loadError')}
            action={
              <BrandButton variant="secondary" onClick={() => void refetch()}>
                {tc('action.retry')}
              </BrandButton>
            }
          />
        ) : (!mounted || isLoading) && !data ? (
          <div
            className="grid gap-4 sm:grid-cols-2 sm:gap-6"
            role="status"
            aria-busy="true"
            aria-label={w('loading')}
          >
            {Array.from({ length: 2 }).map((_, i) => (
              <Placeholder key={i} className="h-48 w-full" />
            ))}
          </div>
        ) : items.length > 0 ? (
          <>
            {/* Search + filters */}
            <div className="space-y-3">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-ink-3"
                  aria-hidden
                />
                <input
                  id="wallet-search"
                  type="search"
                  aria-label={w('searchLabel')}
                  placeholder={w('searchPlaceholder')}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className={`${BRAND_FIELD} w-full pl-9`}
                />
              </div>
              {availableFilters.length > 0 && (
                <div
                  className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
                  role="group"
                  aria-label={w('filterLabel')}
                >
                  {availableFilters.map((c) => {
                    const on = active.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => toggle(c)}
                        aria-pressed={on}
                        className={`${brandChipClasses(on)} h-11 shrink-0 sm:h-9`}
                      >
                        {w(`filter.${c}`)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {sections.length > 0 ? (
              <div className="space-y-10">
                {sections.map((section) => (
                  <section key={section.key} aria-label={sectionLabel(section.key)}>
                    <h2 className="mb-3 text-brand-eyebrow uppercase text-brand-ink-3">
                      {sectionLabel(section.key)}
                    </h2>
                    <ul className="grid list-none gap-4 sm:grid-cols-2 sm:gap-6">
                      {section.items.map((item) => (
                        <li key={item.id} className="min-w-0">
                          <WalletCard item={item} onPreview={preview} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <BrandEmpty title={w('noMatchTitle')} hint={w('noMatchHint')} />
            )}
          </>
        ) : (
          <BrandEmpty
            title={w('emptyTitle')}
            hint={w('emptyHint')}
            action={
              <Link href="/events" className={brandButtonClasses('primary', 'md')}>
                {w('browseEvents')}
              </Link>
            }
          />
        )}
      </div>
    </BrandPage>
  );
}
