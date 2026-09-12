'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { FileText, Heart, Receipt, Ticket, UserRound, Users, ChevronRight } from 'lucide-react';
import { api, tokenStore } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { useMounted } from '@/lib/use-mounted';

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

export default function AccountPage() {
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
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">{t('heading')}</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">{t('lead')}</p>
      </div>
      {bookings && (bookings.upcoming > 0 || bookings.past > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-background-surface p-5 shadow-sm">
            <p className="text-caption text-text-muted">{t('upcomingBookings')}</p>
            <p className="mt-1 text-h3 font-bold text-text-primary">{bookings.upcoming}</p>
          </div>
          <div className="rounded-lg border border-border bg-background-surface p-5 shadow-sm">
            <p className="text-caption text-text-muted">{t('pastBookings')}</p>
            <p className="mt-1 text-h3 font-bold text-text-primary">{bookings.past}</p>
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className="group rounded-lg border border-border bg-background-surface p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-tint-primary text-action-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <ChevronRight className="h-4 w-4 text-text-muted transition-transform group-hover:translate-x-0.5" />
              </div>
              <p className="mt-4 font-semibold text-text-primary">{t(`links.${l.key}.label`)}</p>
              <p className="mt-0.5 text-caption text-text-muted">{t(`links.${l.key}.hint`)}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
