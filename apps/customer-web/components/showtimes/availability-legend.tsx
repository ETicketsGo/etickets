'use client';

import { useTranslations } from 'next-intl';

/** What the pill borders mean. A mark plus a word each, so no state is told by colour alone. */
export function AvailabilityLegend() {
  const t = useTranslations('showtimes.legend');
  const items = [
    { label: t('available'), mark: 'bg-status-success' },
    { label: t('fillingFast'), mark: 'bg-status-warning' },
    { label: t('soldOut'), mark: 'border border-dashed border-text-muted bg-background-subtle' },
  ];
  return (
    <ul
      aria-label={t('label')}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-secondary"
    >
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${item.mark}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
