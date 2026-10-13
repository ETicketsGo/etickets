/**
 * Whether an event waiting for review has already finished.
 *
 * Reported by the design audit: an event dated 17 September sat in "Waiting for a decision" a
 * month later. Nothing about it is wrong in the data - the organizer submitted it in time and
 * nobody decided - but a reviewer approving it would be putting a show on sale that cannot
 * happen. The queue says so in words. It does not expire, reject or approve anything: closing a
 * submission is a person's decision (the organizer may have a reason, or want to re-date it),
 * and a status changed by the clock would leave no one answerable for it.
 *
 * "Finished" is the LAST session being over, so a run that has started but not ended is not
 * flagged. An event with no sessions has no date to be past; the dates column already says so.
 */
export function alreadyHappened(
  e: {
    status: string;
    sessionCount: number;
    firstSessionAt: string | null;
    lastSessionAt: string | null;
  },
  now: Date = new Date(),
): boolean {
  if (e.status !== 'UNDER_REVIEW' || e.sessionCount === 0 || !e.firstSessionAt) return false;
  const last = new Date(e.lastSessionAt ?? e.firstSessionAt);
  return last.getTime() < now.getTime();
}
