'use client';

import { useQueries } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BadgeCheck, ChevronRight, Users } from 'lucide-react';
import { BRAND_FOCUS, brandButtonClasses } from '@eticketsgo/web-kit';
import { api, type OrganizerProfile } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import { ACCOUNT_PANEL, AccountHeading, AccountPage, BrandError } from '@/components/account-brand';
import { Placeholder } from '@/components/home/parts';
import { BrandEmpty } from '@/components/storefront-brand';

/*
  Followed organizers on the brand layer: each a flat white panel on paper with the
  organizer's initial on an ink disc. It was a shadowed card with a blue tile. Same list.
*/

const FOLLOW_KEY = 'etg_following';

function readFollowing(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? '[]') as string[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function OrganizerCard({ org }: { org: OrganizerProfile }) {
  const t = useTranslations('storefront.following');
  const { dateOnly } = useFormat();
  return (
    <Link
      href={`/organizers/${org.id}`}
      className={`group flex items-center gap-4 ${ACCOUNT_PANEL} p-5 transition-colors duration-150 hover:border-brand-ink-3 ${BRAND_FOCUS}`}
    >
      <div
        aria-hidden
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-action font-brand-display text-brand-d3 text-brand-on-action"
      >
        {org.name.charAt(0)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate font-brand-display text-brand-card text-brand-ink group-hover:underline group-hover:underline-offset-4">
            {org.name}
          </p>
          {org.verified && (
            <BadgeCheck className="h-4 w-4 shrink-0 text-brand-info" aria-label={t('verified')} />
          )}
        </div>
        <p className="mt-0.5 truncate text-brand-meta text-brand-ink-2">
          {t('since', { date: dateOnly(org.memberSince), count: org.eventCount })}
        </p>
      </div>
      <ChevronRight
        aria-hidden
        className="h-4 w-4 shrink-0 text-brand-ink-3 transition-transform duration-150 motion-safe:group-hover:translate-x-0.5"
      />
    </Link>
  );
}

export default function FollowingPage() {
  const t = useTranslations('storefront.following');
  const w = useTranslations('storefront.wallet');
  const [ids, setIds] = useState<string[] | null>(null);

  useEffect(() => setIds(readFollowing()), []);

  const results = useQueries({
    queries: (ids ?? []).map((id) => ({
      queryKey: ['organizer', id],
      queryFn: () => api.organizerProfile(id),
    })),
  });

  const loading = ids === null || results.some((r) => r.isLoading);
  const allErrored = ids !== null && ids.length > 0 && results.every((r) => r.isError);
  const organizers = results.map((r) => r.data).filter((o): o is OrganizerProfile => Boolean(o));

  const empty = (
    <BrandEmpty
      title={t('emptyTitle')}
      hint={t('emptyHint')}
      headingLevel="h2"
      action={
        <Link href="/events" className={brandButtonClasses('primary', 'md')}>
          <Users className="h-4 w-4" aria-hidden />
          {w('browseEvents')}
        </Link>
      }
    />
  );

  return (
    <AccountPage>
      <AccountHeading title={t('heading')} lead={t('lead')} />

      {ids !== null && ids.length === 0 ? (
        empty
      ) : allErrored ? (
        <BrandError message={t('loadError')} onRetry={() => results.forEach((r) => r.refetch())} />
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
          {Array.from({ length: ids?.length || 4 }).map((_, i) => (
            <Placeholder key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : organizers.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {organizers.map((org) => (
            <OrganizerCard key={org.id} org={org} />
          ))}
        </div>
      ) : (
        empty
      )}
    </AccountPage>
  );
}
