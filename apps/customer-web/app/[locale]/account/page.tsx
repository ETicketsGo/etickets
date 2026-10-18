'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { FileText, Heart, Receipt, Ticket, UserRound, Users, ChevronRight } from 'lucide-react';
import { BRAND_FOCUS } from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { useMounted } from '@/lib/use-mounted';
import { ACCOUNT_PANEL, AccountHeading, AccountPage } from '@/components/account-brand';

/** Each entry's words live at `storefront.accountHome.links.<key>`. */
const LINKS = [
  { key: 'bookings', href: '/account/bookings', icon: Receipt },
  { key: 'tickets', href: '/account/tickets', icon: Ticket },
  /*
    Its own entry rather than something inside a booking.

    People come looking for a receipt weeks later, for an expense claim, and they are not
    thinking about which booking it belonged to — they are thinking "where are my receipts".
    Filed under the booking it is only findable by somebody who already remembers the trip.
  */
  { key: 'receipts', href: '/account/receipts', icon: FileText },
  { key: 'saved', href: '/account/saved', icon: Heart },
  { key: 'following', href: '/account/following', icon: Users },
  { key: 'profile', href: '/account/profile', icon: UserRound },
] as const;

/*
  The account's front page on the brand layer: paper, the display face for the title, the two
  counts as figures and every section as a flat white panel with an ink icon. It was grey with
  blue icon tiles and cards that lifted on hover. Same links, same order, same words.
*/
export default function AccountIndexPage() {
  const t = useTranslations('storefront.accountHome');
  const router = useRouter();
  const mounted = useMounted();
  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account');
  }, [router]);

  const analyticsQ = useQuery({
    queryKey: ['account', 'analytics'],
    queryFn: () => api.analytics(),
    // Not `typeof window`, which differs between server and first client render. See useMounted.
    enabled: mounted && !!tokenStore.access,
  });
  const bookings = analyticsQ.data?.bookings;

  return (
    <AccountPage width="wide">
      <AccountHeading title={t('heading')} lead={t('lead')} />
      {bookings && (bookings.upcoming > 0 || bookings.past > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={`${ACCOUNT_PANEL} p-5`}>
            <p className="text-brand-eyebrow uppercase text-brand-ink-3">{t('upcomingBookings')}</p>
            <p className="mt-2 text-brand-figure tabular-nums text-brand-ink">
              {bookings.upcoming}
            </p>
          </div>
          <div className={`${ACCOUNT_PANEL} p-5`}>
            <p className="text-brand-eyebrow uppercase text-brand-ink-3">{t('pastBookings')}</p>
            <p className="mt-2 text-brand-figure tabular-nums text-brand-ink">{bookings.past}</p>
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`group block ${ACCOUNT_PANEL} p-5 transition-colors duration-150 hover:border-brand-ink-3 ${BRAND_FOCUS}`}
            >
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-sunken text-brand-ink">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <ChevronRight
                  aria-hidden
                  className="h-4 w-4 text-brand-ink-3 transition-transform duration-150 motion-safe:group-hover:translate-x-0.5"
                />
              </div>
              <p className="mt-4 font-brand-display text-brand-card text-brand-ink">
                {t(`links.${l.key}.label`)}
              </p>
              <p className="mt-1 text-brand-meta text-brand-ink-2">{t(`links.${l.key}.hint`)}</p>
            </Link>
          );
        })}
      </div>
    </AccountPage>
  );
}
