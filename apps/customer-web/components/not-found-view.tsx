'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { BrandButton, brandButtonClasses, useCity } from '@eticketsgo/web-kit';
import { Link, useRouter } from '@/i18n/navigation';
import { BRAND_FIELD } from './booking-brand';
import { BRAND_LEAD, BRAND_PAGE_TITLE } from './brand-forms';
import { BRAND_WRAP, BrandPage } from './storefront-brand';

/*
  ── THE 404, ON THE STOREFRONT'S OWN PAGE ──────────────────────────────────────────────
  A wrong address used to land on a page from the old system, and outside the shop: a grey
  canvas, a blue "Back to home", no header and no footer - so no search box, no way to the
  other sections, and no legal line naming who runs the site. It now renders inside the normal
  shell (see `app/[locale]/[...rest]/page.tsx` for why it reaches the shell at all) on paper.

  One sentence for what happened and what to do, then the two ways on: a search, because the
  usual reason is an old link to something that still exists under another address, and home.
*/
export function NotFoundView() {
  const t = useTranslations('common.notFoundPage');
  const h = useTranslations('home.header');
  const a = useTranslations('common.action');
  const router = useRouter();
  const preference = useCity();
  const [q, setQ] = useState('');

  // The header's search, so both land on Browse the same way, scoped to the visitor's city.
  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (preference.city) params.set('city', preference.city);
    const query = params.toString();
    router.push(query ? `/events?${query}` : '/events');
  };

  return (
    <BrandPage>
      <div className={`${BRAND_WRAP} pt-12 sm:pt-20`}>
        <div className="mx-auto max-w-xl text-center" data-not-found>
          <p aria-hidden className="font-brand-display text-brand-d1 text-brand-ink-3">
            404
          </p>
          <h1 className={`mt-2 ${BRAND_PAGE_TITLE}`}>{t('title')}</h1>
          <p className={`mt-3 ${BRAND_LEAD}`}>{t('lead')}</p>
          {/*
            A plain form, not a second `role="search"` landmark: the header already has one, and
            two search landmarks with no way to tell them apart is what axe reports.
          */}
          <form onSubmit={search} className="mt-8 flex flex-col gap-2 text-left sm:flex-row">
            <label htmlFor="not-found-search" className="sr-only">
              {h('searchLabel')}
            </label>
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-ink-3"
              />
              <input
                id="not-found-search"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={h('searchPlaceholder')}
                className={`${BRAND_FIELD} w-full pl-9`}
              />
            </div>
            <BrandButton type="submit">{a('search')}</BrandButton>
          </form>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/" className={brandButtonClasses('secondary')}>
              {t('home')}
            </Link>
            <Link href="/events" className={brandButtonClasses('quiet')}>
              {t('browse')}
            </Link>
          </div>
        </div>
      </div>
    </BrandPage>
  );
}
