'use client';

import { Badge, StatusBadge } from '@eticketsgo/web-kit';
import { approvalOf } from './event-list-model';

/**
 * Status and approval, side by side and each in words.
 *
 * Two badges because they answer two questions - "is it on sale" and "has it been approved" -
 * and an organizer looking at a paused event needs both: paused by them, or by us. Each says
 * its state in text; the colour only repeats it.
 */
export function EventStateBadges({
  event,
}: {
  event: {
    status: string;
    publishedAt?: string | null;
    reviewNote?: string | null;
    needsReviewOnResume?: boolean;
    pausedByAdmin?: boolean;
  };
}) {
  const approval = approvalOf(event);
  return (
    /*
      `relative` so the hidden "Approval:" is positioned inside this span. Without it, in the
      table's sideways-scrolling box, the hidden text was placed against the page instead and
      widened the whole page by the width of the clipped columns.
    */
    <span className="relative inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge status={event.status} />
      {/*
        Not repeated when it would only say the status again: "Under Review" beside "Awaiting
        approval" is one fact twice.
      */}
      {event.status === 'UNDER_REVIEW' ? null : (
        <Badge tone={approval.tone}>
          <span className="sr-only">Approval: </span>
          {approval.label}
        </Badge>
      )}
    </span>
  );
}
