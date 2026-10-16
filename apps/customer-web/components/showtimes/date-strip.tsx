'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { dayLabelParts, type StripDay } from '@eticketsgo/web-kit';
import { useFormat } from '@/lib/format';
import { focusRing } from './styles';

/**
 * Seven consecutive days, one of them chosen.
 *
 * Days with nothing on stay in the strip, dimmed and disabled, so it reads as a calendar: a
 * strip that silently skipped Tuesday would let someone assume Wednesday is tomorrow.
 * `paging` is null when every show fits on one page, which is the common case.
 */
export function DateStrip({
  days,
  selected,
  onSelect,
  paging,
}: {
  days: StripDay[];
  selected: string | null;
  onSelect: (date: string) => void;
  paging: { earlier: (() => void) | null; later: (() => void) | null } | null;
}) {
  const t = useTranslations('showtimes.dates');
  const { locale } = useFormat();

  return (
    <div className="flex min-w-0 items-center gap-1 sm:gap-2">
      {paging && (
        <PageButton label={t('earlier')} onClick={paging.earlier}>
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </PageButton>
      )}
      <div
        role="group"
        aria-label={t('label')}
        className="flex min-w-0 flex-1 snap-x gap-2 overflow-x-auto overscroll-x-contain p-1.5 [scrollbar-width:thin]"
      >
        {days.map((day) => {
          const parts = dayLabelParts(day.date, locale);
          const isSelected = day.date === selected;
          const empty = day.shows === 0;
          return (
            <button
              key={day.date}
              type="button"
              data-date={day.date}
              aria-pressed={isSelected}
              aria-label={empty ? `${parts.full}, ${t('noShows')}` : parts.full}
              disabled={empty}
              onClick={() => onSelect(day.date)}
              className={`flex w-[4.25rem] shrink-0 snap-start flex-col items-center rounded-brand-control border px-1 py-2 text-center motion-safe:transition-colors motion-safe:duration-150 ${focusRing} ${
                isSelected
                  ? 'border-brand-action bg-brand-action text-brand-on-action'
                  : empty
                    ? 'cursor-not-allowed border-dashed border-brand-line-strong bg-transparent text-brand-ink-3'
                    : 'border-brand-line-strong bg-brand-surface text-brand-ink hover:border-brand-ink-3'
              }`}
            >
              <span className="text-brand-eyebrow uppercase">{parts.weekday}</span>
              <span className="font-brand-display text-brand-card leading-tight tabular-nums">
                {parts.day}
              </span>
              <span className="text-brand-meta">{parts.month}</span>
            </button>
          );
        })}
      </div>
      {paging && (
        <PageButton label={t('later')} onClick={paging.later}>
          <ChevronRight className="h-5 w-5" aria-hidden />
        </PageButton>
      )}
    </div>
  );
}

function PageButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (() => void) | null;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={!onClick}
      onClick={onClick ?? undefined}
      className={`inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-brand-control text-brand-ink-2 hover:bg-brand-surface hover:text-brand-ink disabled:cursor-not-allowed disabled:text-brand-ink-3 disabled:hover:bg-transparent ${focusRing}`}
    >
      {children}
    </button>
  );
}
