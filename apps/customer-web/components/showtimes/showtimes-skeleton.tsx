'use client';

import { useTranslations } from 'next-intl';

const block = 'rounded-brand-control bg-brand-sunken motion-safe:animate-pulse';

/** The page's shape while it loads, so nothing jumps when the showtimes arrive. */
export function ShowtimesSkeleton() {
  const t = useTranslations('showtimes.movie');
  return (
    <div role="status" className="space-y-8 sm:space-y-10">
      <span className="sr-only">{t('loading')}</span>
      {/* The film header's stage band, at the same size, so the page does not jump. */}
      <div
        aria-hidden
        data-brand-tone="stage"
        className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 bg-brand-canvas px-4 pb-8 pt-6 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-x-8 sm:px-6 sm:pb-10 sm:pt-10 lg:grid-cols-[14rem_minmax(0,1fr)] lg:px-10"
      >
        <div className={`aspect-[2/3] w-full rounded-brand-card ${block}`} />
        <div className="min-w-0 space-y-3 self-center">
          <div className={`h-5 w-24 ${block}`} />
          <div className={`h-8 w-3/4 ${block}`} />
          <div className={`h-4 w-1/2 ${block}`} />
        </div>
      </div>
      <div aria-hidden className="mx-auto max-w-shell space-y-4 px-4 sm:px-6 lg:px-10">
        <div className={`h-6 w-32 ${block}`} />
        <div className="flex gap-2 overflow-hidden p-1.5">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className={`h-[4.75rem] w-[4.25rem] shrink-0 ${block}`} />
          ))}
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="space-y-3 rounded-brand-card border border-brand-line bg-brand-surface p-4 sm:p-5"
          >
            <div className={`h-5 w-48 max-w-full ${block}`} />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
              {Array.from({ length: 4 }).map((__, j) => (
                <div key={j} className={`h-[3.75rem] ${block}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
