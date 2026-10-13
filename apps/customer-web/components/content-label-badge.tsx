'use client';

import { useTranslations } from 'next-intl';
import type { ContentLabel } from '@eticketsgo/web-kit';

/**
 * A quiet marker on a listing that is sample content or test data.
 *
 * QA keeps its certification fixtures AND carries a curated demo catalogue, so a reader
 * (and a screenshot) needs to tell them apart without anything being deleted. The word is the
 * signal; the dashed outline on TEST is a second cue for anyone who cannot rely on the text
 * alone. Renders nothing when the API sent no label, which is always the case in production.
 */
export function ContentLabelBadge({
  label,
  className = '',
}: {
  label?: ContentLabel | null;
  className?: string;
}) {
  const t = useTranslations('common.contentLabel');
  if (!label) return null;
  return (
    <span
      data-content-label={label}
      className={`inline-flex h-5 items-center whitespace-nowrap rounded border bg-brand-surface px-1.5 text-[0.6875rem] font-semibold text-brand-ink-2 ${
        label === 'TEST' ? 'border-dashed border-brand-line-strong' : 'border-brand-line-strong'
      } ${className}`}
    >
      {t(label)}
    </span>
  );
}
