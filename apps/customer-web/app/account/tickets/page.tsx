'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Ticket, Trash2, WifiOff } from 'lucide-react';
import {
  buildWallet,
  filterWallet,
  searchWallet,
  sectionizeWallet,
  useConnectivity,
  useToast,
  DEFAULT_WALLET_FLAGS,
  WALLET_SECTION_LABELS,
  type OfflineSyncState,
  type WalletFilter,
  type WalletFlags,
  type WalletItem,
} from '@eticketsgo/web-kit';
import { tokenStore } from '@/lib/api';
import { EmptyState, ErrorState, ButtonLink, Input } from '@/components/ui';
import { WalletCard } from '@/components/wallet-card';
import { fetchWalletWithOffline, lastSyncedAt, deriveSyncState } from '@/lib/offline/sync';
import { clearAllOffline } from '@/lib/offline/wallet-store';
import { requestWalletSync } from '@/lib/push';

function formatSynced(ts: number | null): string {
  if (!ts) return 'not yet';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

const SYNC_LABEL: Record<OfflineSyncState, string> = {
  CURRENT: 'Up to date',
  SYNCING: 'Syncing…',
  STALE: 'Offline — showing saved passes',
  OFFLINE: 'Offline',
  PARTIAL: 'Partially synced',
  FAILED: 'Sync failed',
  REQUIRES_SIGN_IN: 'Sign in required',
};

const FILTER_CHIPS: { value: WalletFilter; label: string }[] = [
  { value: 'movies', label: 'Movies' },
  { value: 'events', label: 'Events' },
  { value: 'active', label: 'Active' },
  { value: 'memberships', label: 'Memberships' },
  { value: 'coupons', label: 'Coupons' },
  { value: 'parking', label: 'Parking' },
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
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
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
    hasToken: typeof window !== 'undefined' && !!tokenStore.access,
    connectivity: connectivity.state,
    isFetching,
    hasData: !!data && data.length > 0,
    isError,
  });

  const clearOffline = async () => {
    await clearAllOffline();
    toast.push('Offline data cleared from this device.', 'success');
  };

  // Build the generic wallet, then apply search + filters, then sectionize.
  const items = useMemo(() => (data ? buildWallet({ tickets: data }, flags) : []), [data, flags]);
  const availableFilters = useMemo(() => {
    const present = new Set(items.flatMap((i) => i.filters));
    return FILTER_CHIPS.filter((c) => present.has(c.value));
  }, [items]);
  const sections = useMemo(
    () => sectionizeWallet(filterWallet(searchWallet(items, q), active)),
    [items, q, active],
  );

  const toggle = (f: WalletFilter) =>
    setActive((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  const preview = (item: WalletItem) =>
    toast.push(`${item.title} — preview wallet item (feature flag).`, 'info');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">My experiences</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Your tickets, passes and more — everything in one wallet.
        </p>
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
          {SYNC_LABEL[syncState]}
          <span className="font-normal text-text-muted">· updated {formatSynced(syncedAt)}</span>
        </span>
        <span className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            disabled={!online || isFetching}
            className="inline-flex items-center gap-1.5 font-medium text-action-primary hover:underline disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Sync now
          </button>
          <button
            onClick={clearOffline}
            className="inline-flex items-center gap-1.5 font-medium text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear offline data
          </button>
        </span>
      </div>

      {isError && !data ? (
        <ErrorState
          message="We couldn't load your wallet. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading && !data ? (
        <div
          className="grid gap-6 sm:grid-cols-2"
          role="status"
          aria-busy="true"
          aria-label="Loading wallet"
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
              aria-label="Search your wallet"
              placeholder="Search by name, venue, reference, seat…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {availableFilters.length > 0 && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter wallet">
                {availableFilters.map((c) => {
                  const on = active.includes(c.value);
                  return (
                    <button
                      key={c.value}
                      onClick={() => toggle(c.value)}
                      aria-pressed={on}
                      className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                        on
                          ? 'border-action-primary bg-tint-primary text-action-primary'
                          : 'border-border text-text-secondary hover:bg-background-subtle'
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {sections.length > 0 ? (
            <div className="space-y-8">
              {sections.map((section) => (
                <section
                  key={section.key}
                  aria-label={
                    WALLET_SECTION_LABELS[section.key as keyof typeof WALLET_SECTION_LABELS]
                  }
                >
                  <h2 className="mb-3 text-caption font-semibold uppercase tracking-wide text-text-muted">
                    {WALLET_SECTION_LABELS[section.key as keyof typeof WALLET_SECTION_LABELS]}
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
            <EmptyState
              title="Nothing matches"
              hint="Try a different search or clear your filters."
              icon={Ticket}
            />
          )}
        </>
      ) : (
        <EmptyState
          title="Your wallet is empty"
          hint="Book an event to see your tickets and passes here."
          icon={Ticket}
          action={<ButtonLink href="/events">Browse events</ButtonLink>}
        />
      )}
    </div>
  );
}
