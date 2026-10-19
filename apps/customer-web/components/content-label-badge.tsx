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
 *
 * On the brand layer. It used the global tokens while some of the pages it sits on had not
 * opted in; every one of them now has (the home page, Explore, Movies, Browse, the film and
 * event pages), so it takes the paper and ink of the page around it - and on a stage band (the
 * film page's header) the stage's, which the global tokens could not follow.
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
      className={`inline-flex h-5 items-center whitespace-nowrap rounded border border-brand-line-strong bg-transparent px-1.5 text-[0.6875rem] font-semibold text-brand-ink-3 ${
        label === 'TEST' ? 'border-dashed' : ''
      } ${className}`}
    >
      {t(label)}
    </span>
  );
}
