'use client';

import { StatusPill } from '@eticketsgo/web-kit';
import { lifecycleOf, type LifecycleInput } from './event-lifecycle';

/**
 * Where the event is in its life, in the console's one vocabulary: Draft, In review, Approved,
 * Published, Ended, Cancelled - plus, when the stage alone hides it, the one fact that matters
 * ("Paused by platform", "Changes requested", "Sold out").
 *
 * Words always; the colour and the dot only repeat them. "Stage: " is said to a screen reader
 * so the pill is not read as a bare word between a title and a date.
 */
export function EventStateBadges({
  event,
  size = 'sm',
}: {
  event: LifecycleInput;
  size?: 'sm' | 'md';
}) {
  const life = lifecycleOf(event);
  return (
    // `relative` keeps the hidden label inside this span in a sideways-scrolling table.
    <span className="relative inline-flex max-w-full flex-wrap items-center gap-1.5">
      <StatusPill tone={life.tone} size={size}>
        <span className="sr-only">Stage: </span>
        {life.label}
      </StatusPill>
      {life.detail ? (
        <StatusPill tone={life.detail.tone} size={size} dot={false}>
          {life.detail.label}
        </StatusPill>
      ) : null}
    </span>
  );
}

/**
 * The same, laid over a card's artwork: one pill, the stage, with the detail joined to it
 * ("Approved - Paused") so the corner of the picture never holds a stack of two.
 */
export function EventStatePill({ event }: { event: LifecycleInput }) {
  const life = lifecycleOf(event);
  const tone = life.detail && life.detail.tone !== 'info' ? life.detail.tone : life.tone;
  return (
    <StatusPill tone={tone} size="sm" className="shadow-sm">
      <span className="sr-only">Stage: </span>
      {life.label}
      {life.detail ? ` - ${life.detail.label}` : ''}
    </StatusPill>
  );
}
