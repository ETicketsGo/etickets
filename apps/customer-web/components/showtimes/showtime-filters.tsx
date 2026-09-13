'use client';

import { Check, X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  TIMES_OF_DAY,
  hasActiveShowtimeFilters,
  type ShowtimeFilters,
  type TimeOfDay,
} from '@eticketsgo/web-kit';
import { focusRing } from './styles';

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Format and time-of-day chips, all applied on the client over the rows already loaded.
 *
 * The format group appears only when there is a choice to make. A time chip with nothing
 * behind it on the chosen day is disabled rather than hidden, so the four parts of the day never
 * shift position between days — unless it is already on, so it can always be turned off.
 */
export function ShowtimeFilterBar({
  formats,
  filters,
  timeCounts,
  onChange,
}: {
  formats: string[];
  filters: ShowtimeFilters;
  timeCounts: Record<TimeOfDay, number>;
  onChange: (next: ShowtimeFilters) => void;
}) {
  const t = useTranslations('showtimes.filters');
  const formatId = useId();
  const timeId = useId();

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        role="group"
        aria-label={t('label')}
        className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto p-1.5 [scrollbar-width:thin]"
      >
        {formats.length > 1 && (
          <>
            <div
              role="group"
              aria-labelledby={formatId}
              className="flex shrink-0 items-center gap-2"
            >
              <span id={formatId} className="text-caption font-medium text-text-muted">
                {t('format')}
              </span>
              {formats.map((format) => (
                <Chip
                  key={format}
                  pressed={filters.formats.includes(format)}
                  onClick={() => onChange({ ...filters, formats: toggle(filters.formats, format) })}
                  data={{ 'data-format': format }}
                >
                  {format}
                </Chip>
              ))}
            </div>
            <span aria-hidden className="h-6 w-px shrink-0 bg-border" />
          </>
        )}
        <div role="group" aria-labelledby={timeId} className="flex shrink-0 items-center gap-2">
          <span id={timeId} className="text-caption font-medium text-text-muted">
            {t('time')}
          </span>
          {TIMES_OF_DAY.map((bucket) => {
            const pressed = filters.times.includes(bucket);
            return (
              <Chip
                key={bucket}
                pressed={pressed}
                disabled={!pressed && timeCounts[bucket] === 0}
                onClick={() => onChange({ ...filters, times: toggle(filters.times, bucket) })}
                data={{ 'data-time-of-day': bucket }}
              >
                {t(`timeOfDay.${bucket}.label`)}
                <span className="font-normal">{t(`timeOfDay.${bucket}.range`)}</span>
              </Chip>
            );
          })}
        </div>
      </div>
      {hasActiveShowtimeFilters(filters) && (
        <button
          type="button"
          onClick={() => onChange({ formats: [], times: [] })}
          className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-2 text-caption font-semibold text-text-primary underline underline-offset-2 hover:bg-background-subtle ${focusRing}`}
        >
          <X className="h-4 w-4" aria-hidden />
          {t('clear')}
        </button>
      )}
    </div>
  );
}

function Chip({
  pressed,
  disabled,
  onClick,
  data,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  data?: Record<`data-${string}`, string>;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      {...data}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-caption font-medium motion-safe:transition-colors motion-safe:duration-150 ${focusRing} ${
        pressed
          ? 'border-action-primary bg-tint-primary text-action-primary'
          : disabled
            ? 'cursor-not-allowed border-dashed border-border bg-background-subtle text-text-muted'
            : 'border-border-input bg-background-surface text-text-secondary hover:bg-background-subtle hover:text-text-primary'
      }`}
    >
      {/* The check says "on" in a shape, not only in the chip's colour. */}
      {pressed && <Check className="h-3.5 w-3.5" aria-hidden />}
      {children}
    </button>
  );
}
