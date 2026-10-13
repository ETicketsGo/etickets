'use client';

import { useTranslations } from 'next-intl';
import type { ContentLabel } from '@eticketsgo/web-kit';

/**
 * A quiet marker on a listing that is sample content or test data.
 *
 * QA keeps its certification fixtures AND carries a curated demo catalogue, so a reader
 * (and a screenshot) needs to tell them apart without anything being deleted. The word is the
 * signal; the dashed outline on TEST is a second cue for anyone who cannot rely on the text
 * alone. Uses the global tokens, not the brand layer: those resolve only inside `data-brand`,
 * and this badge also sits on pages that have not opted in. Renders nothing when the API
 * sent no label, which is always the case in production.
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
      className={`inline-flex h-5 items-center whitespace-nowrap rounded border bg-background-surface px-1.5 text-[0.6875rem] font-semibold text-text-secondary ${
        label === 'TEST' ? 'border-dashed border-text-muted' : 'border-border'
      } ${className}`}
    >
      {t(label)}
    </span>
  );
}
