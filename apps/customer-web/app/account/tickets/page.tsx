'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ticket } from 'lucide-react';
import {
  buildWallet,
  filterWallet,
  searchWallet,
  sectionizeWallet,
  useToast,
  DEFAULT_WALLET_FLAGS,
  WALLET_SECTION_LABELS,
  type WalletFilter,
  type WalletFlags,
  type WalletItem,
} from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { EmptyState, ErrorState, ButtonLink, Input } from '@/components/ui';
import { WalletCard } from '@/components/wallet-card';
import { readWalletCache, writeWalletCache } from '@/lib/wallet-cache';

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

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['wallet'],
    queryFn: () => api.wallet(),
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
    initialData: () => readWalletCache(),
    initialDataUpdatedAt: 0,
  });
  useEffect(() => {
    if (data && data.length) writeWalletCache(data);
  }, [data]);

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

      {isError && !data ? (
        <ErrorState
          message="We couldn't load your wallet. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading && !data ? (
        <div className="grid gap-6 sm:grid-cols-2" aria-busy="true" aria-label="Loading wallet">
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
                          ? 'border-action-primary bg-action-primary/10 text-action-primary'
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
