'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { RefreshCw, Ticket, Trash2, WifiOff } from 'lucide-react';
import {
  buildWallet,
  filterWallet,
  searchWallet,
  sectionizeWallet,
  summarizeBookingGroup,
  useConnectivity,
  useToast,
  DEFAULT_WALLET_FLAGS,
  WALLET_SECTION_LABELS,
  type GroupSummaryWords,
  type WalletFilter,
  type WalletFlags,
  type WalletItem,
  type WalletLabels,
} from '@eticketsgo/web-kit';
import { tokenStore } from '@/lib/api';
import { EmptyState, ErrorState, ButtonLink, Input } from '@/components/ui';
import { WalletCard } from '@/components/wallet-card';
import { fetchWalletWithOffline, lastSyncedAt, deriveSyncState } from '@/lib/offline/sync';
import { clearAllOffline } from '@/lib/offline/wallet-store';
import { requestWalletSync } from '@/lib/push';
import { useTranslations } from 'next-intl';
import { useMounted } from '@/lib/use-mounted';

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
    <div className="space-y-6">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">{w('heading')}</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">{w('lead')}</p>
      </div>

      {/* Offline / sync status — announced to assistive tech, never colour-only */}
      <div
        role="status"
        aria-live="polite"
        className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-caption ${
          online
            ? 'border-border bg-background-surface text-text-secondary'
            : 'border-status-warning/30 bg-status-warning/10 text-status-warning'
        }`}
      >
        <span className="inline-flex items-center gap-2 font-medium">
          {!online && <WifiOff className="h-3.5 w-3.5" aria-hidden />}
          {w(`sync.${syncState}`)}
          <span className="font-normal text-text-muted">
            {w('updated', { when: formatSynced(syncedAt, w) })}
          </span>
        </span>
        <span className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            disabled={!online || isFetching}
            className="inline-flex items-center gap-1.5 font-medium text-action-primary hover:underline disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />{' '}
            {w('syncNow')}
          </button>
          <button
            onClick={clearOffline}
            className="inline-flex items-center gap-1.5 font-medium text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Trash2 className="h-3.5 w-3.5" /> {w('clearOffline')}
          </button>
        </span>
      </div>

      {isError && !data ? (
        <ErrorState message={w('loadError')} onRetry={() => refetch()} />
      ) : (!mounted || isLoading) && !data ? (
        <div
          className="grid gap-6 sm:grid-cols-2"
          role="status"
          aria-busy="true"
          aria-label={w('loading')}
        >
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-56 animate-pulse rounded-lg bg-background-subtle" />
          ))}
        </div>
      ) : items.length > 0 ? (
        <>
          {/* Search + filters */}
          <div className="space-y-3">
            <Input
              id="wallet-search"
              aria-label={w('searchLabel')}
              placeholder={w('searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {availableFilters.length > 0 && (
              <div className="flex flex-wrap gap-2" role="group" aria-label={w('filterLabel')}>
                {availableFilters.map((c) => {
                  const on = active.includes(c);
                  return (
                    <button
                      key={c}
                      onClick={() => toggle(c)}
                      aria-pressed={on}
                      className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                        on
                          ? 'border-action-primary bg-tint-primary text-action-primary'
                          : 'border-border text-text-secondary hover:bg-background-subtle'
                      }`}
                    >
                      {w(`filter.${c}`)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {sections.length > 0 ? (
            <div className="space-y-8">
              {sections.map((section) => (
                <section key={section.key} aria-label={sectionLabel(section.key)}>
                  <h2 className="mb-3 text-caption font-semibold uppercase tracking-wide text-text-muted">
                    {sectionLabel(section.key)}
                  </h2>
                  <ul className="grid list-none gap-6 sm:grid-cols-2">
                    {section.items.map((item) => (
                      <li key={item.id}>
                        <WalletCard item={item} onPreview={preview} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <EmptyState title={w('noMatchTitle')} hint={w('noMatchHint')} icon={Ticket} />
          )}
        </>
      ) : (
        <EmptyState
          title={w('emptyTitle')}
          hint={w('emptyHint')}
          icon={Ticket}
          action={<ButtonLink href="/events">{w('browseEvents')}</ButtonLink>}
        />
      )}
    </div>
  );
}
