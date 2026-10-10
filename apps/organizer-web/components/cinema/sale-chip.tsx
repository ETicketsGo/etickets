'use client';

import { CircleCheck, CircleDashed, CircleSlash, Loader2 } from 'lucide-react';
import type { SaleVerdict, Tone } from './cinema-model';

const TONE: Record<Tone, string> = {
  success: 'bg-tint-success text-status-success',
  warning: 'bg-tint-warning text-status-warning',
  error: 'bg-tint-error text-status-error',
  info: 'bg-tint-info text-status-info',
  neutral: 'bg-background-subtle text-text-secondary',
};

/**
 * "Selling" or "Not selling: <reason>", always in words with an icon beside them.
 *
 * The words are the state; colour only repeats them. The chip wraps rather than truncating,
 * because the reason is the useful half and an ellipsis would cut exactly that off.
 */
export function SaleChip({
  verdict,
  className = '',
}: {
  verdict: Pick<SaleVerdict, 'label' | 'tone' | 'selling'>;
  className?: string;
}) {
  const checking = verdict.label === 'Checking sale status';
  const Icon = checking
    ? Loader2
    : verdict.selling
      ? CircleCheck
      : verdict.label.startsWith('Not selling')
        ? CircleSlash
        : CircleDashed;
  return (
    <span
      className={`inline-flex max-w-full items-start gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-medium ${TONE[verdict.tone]} ${className}`}
    >
      <Icon
        className={`mt-[3px] h-3.5 w-3.5 shrink-0 ${checking ? 'animate-spin motion-reduce:animate-none' : ''}`}
        aria-hidden
      />
      <span className="min-w-0 break-words">{verdict.label}</span>
    </span>
  );
}
