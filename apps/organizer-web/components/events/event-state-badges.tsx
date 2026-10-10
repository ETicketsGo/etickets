'use client';

import { Badge } from '@eticketsgo/web-kit';
import { lifecycleOf, type LifecycleInput } from './event-lifecycle';

const DOT: Record<string, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-muted',
};

/**
 * Where the event is in its life, in the console's one vocabulary: Draft, In review, Approved,
 * Published, Ended, Cancelled - plus, when the stage alone hides it, the one fact that matters
 * ("Paused by platform", "Changes requested", "Sold out").
 *
 * Words always; the colour and the dot only repeat them. Replaces the enum spelled out
 * ("PUBLISHED") next to a second "Approved" badge that said the same thing twice.
 */
export function EventStateBadges({ event }: { event: LifecycleInput }) {
  const life = lifecycleOf(event);
  return (
    // `relative` keeps the hidden label inside this span in a sideways-scrolling table.
    <span className="relative inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={life.tone}>
        <span className={`h-1.5 w-1.5 rounded-full ${DOT[life.tone]}`} aria-hidden />
        <span className="sr-only">Stage: </span>
        {life.label}
      </Badge>
      {life.detail ? <Badge tone={life.detail.tone}>{life.detail.label}</Badge> : null}
    </span>
  );
}
