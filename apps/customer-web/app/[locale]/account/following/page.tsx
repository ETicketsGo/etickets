'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { BadgeCheck, ChevronDown, Users } from 'lucide-react';
import { BRAND_FOCUS, brandButtonClasses, useToast } from '@eticketsgo/web-kit';
import { api, type FollowedOrganizer } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import { ACCOUNT_PANEL, AccountHeading, AccountPage, BrandError } from '@/components/account-brand';
import { FollowPreferences } from '@/components/follow-preferences';
import { Placeholder } from '@/components/home/parts';
import { BrandEmpty } from '@/components/storefront-brand';
import { BrandActionButton } from '@/components/brand-forms';
import { BRAND_LINK } from '@/components/booking-brand';
import { SignInRequired, isAuthFailure, useSignedIn } from '@/components/sign-in-required';

/*
  The organizers this person follows, from the API.

  This page used to read a list of ids from this browser's localStorage (`etg_following`), so a
  follow existed on one device only and the server never knew. Those old local follows are
  moved to the account once, the first time this page loads signed in, and the local key is
  then removed. Moving them is not consent to anything: a follow turns on no email.
*/

const LEGACY_FOLLOW_KEY = 'etg_following';

function readLegacyFollows(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(LEGACY_FOLLOW_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function clearLegacyFollows(): void {
  try {
    localStorage.removeItem(LEGACY_FOLLOW_KEY);
  } catch {
    /* storage blocked: nothing to clear */
  }
}

function FollowedCard({ item }: { item: FollowedOrganizer }) {
  const t = useTranslations('storefront.following');
  const { dateOnly } = useFormat();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const org = item.organization;

  const unfollow = useMutation({
    mutationFn: () => api.unfollow(org.id),
    onSuccess: () => {
      toast.push(t('unfollowed', { name: org.name }), 'success');
      qc.invalidateQueries({ queryKey: ['following'] });
      qc.invalidateQueries({ queryKey: ['follow', org.id] });
    },
    onError: () => toast.push(t('saveError'), 'error'),
  });

  return (
    <li className={`${ACCOUNT_PANEL} p-5`}>
      <div className="flex items-center gap-4">
        <div
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-action font-brand-display text-brand-d3 text-brand-on-action"
        >
          {org.name.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Link
              href={`/organizers/${org.id}`}
              className={`truncate font-brand-display text-brand-card text-brand-ink hover:underline hover:underline-offset-4 ${BRAND_FOCUS}`}
            >
              {org.name}
            </Link>
            {org.verified && (
              <BadgeCheck className="h-4 w-4 shrink-0 text-brand-info" aria-label={t('verified')} />
            )}
          </div>
          <p className="mt-0.5 truncate text-brand-meta text-brand-ink-2">
            {t('since', { date: dateOnly(org.memberSince), count: org.eventCount })}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex min-h-11 items-center gap-1 text-brand-ui ${BRAND_LINK}`}
        >
          {t('choose')}
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
        <BrandActionButton
          variant="secondary"
          size="sm"
          loading={unfollow.isPending}
          onClick={() => unfollow.mutate()}
          aria-label={t('unfollowLabel', { name: org.name })}
        >
          {t('unfollow')}
        </BrandActionButton>
      </div>
      {open && (
        <div className="mt-4 border-t border-brand-line pt-4">
          <FollowPreferences organizationId={org.id} initial={item.preferences} />
        </div>
      )}
    </li>
  );
}

export default function FollowingPage() {
  const t = useTranslations('storefront.following');
  const w = useTranslations('storefront.wallet');
  const signedIn = useSignedIn();
  const qc = useQueryClient();
  const migrated = useRef(false);

  const list = useQuery({
    queryKey: ['following'],
    queryFn: () => api.followingList({ pageSize: 50 }),
    enabled: signedIn === true,
  });

  // Move the old browser-only follows to the account, once.
  useEffect(() => {
    if (signedIn !== true || migrated.current) return;
    migrated.current = true;
    const legacy = readLegacyFollows();
    if (legacy.length === 0) return;
    void Promise.allSettled(legacy.map((id) => api.follow(id, 'LOCAL_MIGRATION'))).then(() => {
      clearLegacyFollows();
      qc.invalidateQueries({ queryKey: ['following'] });
    });
  }, [signedIn, qc]);

  if (signedIn === false || isAuthFailure(list.error)) {
    return (
      <AccountPage>
        <SignInRequired title={t('signInTitle')} description={t('signInDescription')} />
      </AccountPage>
    );
  }

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

      {signedIn === null || list.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Placeholder key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : list.isError ? (
        <BrandError message={t('loadError')} onRetry={() => list.refetch()} />
      ) : list.data && list.data.items.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {list.data.items.map((item) => (
            <FollowedCard key={item.organization.id} item={item} />
          ))}
        </ul>
      ) : (
        empty
      )}
    </AccountPage>
  );
}
