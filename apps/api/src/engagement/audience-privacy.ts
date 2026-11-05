/**
 * The smallest group of people an organizer may see a count for.
 *
 * A bucket like "2 followers in Guntur" points at real people the organizer may know by
 * name. Below this size a bucket is hidden, not rounded: a rounded small number still says
 * "somebody there", and a hidden one says nothing.
 */
export const AUDIENCE_PRIVACY_THRESHOLD = 5;

export interface CityBucket {
  city: string;
  country: string | null;
  followers: number;
}

export interface ThresholdedBuckets {
  buckets: CityBucket[];
  /** How many buckets were hidden. The count of groups, never the people in them. */
  hiddenBuckets: number;
  threshold: number;
}

/** Keep the buckets at or above the threshold, largest first. Pure. */
export function applyPrivacyThreshold(
  buckets: readonly CityBucket[],
  threshold = AUDIENCE_PRIVACY_THRESHOLD,
): ThresholdedBuckets {
  const shown = buckets
    .filter((b) => b.followers >= threshold)
    .slice()
    .sort((a, b) => b.followers - a.followers || a.city.localeCompare(b.city));
  return { buckets: shown, hiddenBuckets: buckets.length - shown.length, threshold };
}

/**
 * Turn per-bucket NEW follower counts into a series with a running total.
 *
 * `total` is the number of people following now. Unfollowing deletes the follow, so the
 * running total is "people who follow today, by when they started" - it never goes down.
 */
export function withRunningTotal(
  points: readonly { start: string; newFollowers: number }[],
  total: number,
): { start: string; newFollowers: number; followers: number }[] {
  const out: { start: string; newFollowers: number; followers: number }[] = [];
  let later = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    out.unshift({ ...points[i], followers: total - later });
    later += points[i].newFollowers;
  }
  return out;
}
