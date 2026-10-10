import type { FocalPoint } from '@eticketsgo/web-kit';

/**
 * The images a new event is still waiting for, as a queue with one rule per state.
 *
 * ── WHY A QUEUE AND NOT A LOOP ─────────────────────────────────────────────────────
 * The wizard used to create the event and then upload its images in a plain loop inside the
 * click handler. Leaving the page while that loop ran saved the event without its images, and
 * nothing anywhere said so: the loop's progress lived in a closure that was gone. Here every
 * file has a state that outlives the page (see `image-outbox.ts`), so a reload of the event can
 * say which images are attached, which failed, and offer Retry.
 *
 * ── STRICTLY IN ORDER, AND A FAILURE PAUSES THE REST ───────────────────────────────
 * The first image is the cover, and the API puts each upload after the ones already there. If
 * image 2 went up while image 1 had failed, a later retry of image 1 would land LAST and the
 * cover would be whatever happened to succeed first. So the queue never skips: a failed or
 * interrupted file holds the ones behind it ("Waiting") until it is retried or removed. One
 * Retry resumes the lot, in the order the organizer chose.
 *
 * ── A RETRY IS THE SAME REQUEST ────────────────────────────────────────────────────
 * Each file keeps the key it was given when it was picked, and the upload sends it as its
 * Idempotency-Key. A file whose upload DID arrive before the page lost the answer is answered
 * as done on retry instead of being added twice.
 */
export type UploadStatus = 'waiting' | 'uploading' | 'done' | 'failed' | 'interrupted';

export interface UploadItem {
  /** Picked-file id, and the upload's Idempotency-Key. */
  key: string;
  status: UploadStatus;
  /** Why the last attempt failed, in words for the organizer. */
  error?: string;
  /** Uploads started for this file, across retries and reloads in this page. */
  attempts: number;
  /** Where crops of this image are centred, set after it is saved. Null keeps the middle. */
  focal: FocalPoint | null;
}

export interface UploadQueue {
  eventId: string;
  items: UploadItem[];
}

export type UploadAction =
  | { type: 'add'; items: { key: string; focal?: FocalPoint | null }[] }
  | { type: 'start'; key: string }
  | { type: 'succeed'; key: string }
  | { type: 'fail'; key: string; error: string }
  /** Every failed or interrupted file goes back in line, in its place. */
  | { type: 'retry' }
  /** The organizer gives up on one file. Never one that is uploading right now. */
  | { type: 'dismiss'; key: string }
  /**
   * The queue as it was found after the page that ran it went away. An upload that was in
   * flight may or may not have arrived, so it is neither done nor failed: interrupted.
   */
  | { type: 'restore' };

export function emptyQueue(eventId: string): UploadQueue {
  return { eventId, items: [] };
}

function update(queue: UploadQueue, key: string, change: (item: UploadItem) => UploadItem) {
  return { ...queue, items: queue.items.map((item) => (item.key === key ? change(item) : item)) };
}

export function uploadReducer(queue: UploadQueue, action: UploadAction): UploadQueue {
  switch (action.type) {
    case 'add': {
      // A key already in the queue is the same file sent twice (a double submit): ignored.
      const known = new Set(queue.items.map((item) => item.key));
      const fresh = action.items
        .filter((item) => !known.has(item.key))
        .map((item): UploadItem => ({
          key: item.key,
          status: 'waiting',
          attempts: 0,
          focal: item.focal ?? null,
        }));
      return fresh.length ? { ...queue, items: [...queue.items, ...fresh] } : queue;
    }
    case 'start':
      // Only the head of the line may start; anything else would upload out of order.
      if (nextUpload(queue) !== action.key) return queue;
      return update(queue, action.key, (item) => ({
        ...item,
        status: 'uploading',
        error: undefined,
        attempts: item.attempts + 1,
      }));
    case 'succeed':
      return update(queue, action.key, (item) =>
        item.status === 'uploading' ? { ...item, status: 'done', error: undefined } : item,
      );
    case 'fail':
      return update(queue, action.key, (item) =>
        item.status === 'uploading' ? { ...item, status: 'failed', error: action.error } : item,
      );
    case 'retry':
      return {
        ...queue,
        items: queue.items.map((item) =>
          item.status === 'failed' || item.status === 'interrupted'
            ? { ...item, status: 'waiting' }
            : item,
        ),
      };
    case 'dismiss':
      return {
        ...queue,
        items: queue.items.filter((item) => item.key !== action.key || item.status === 'uploading'),
      };
    case 'restore':
      return {
        ...queue,
        items: queue.items.map((item) =>
          item.status === 'uploading'
            ? {
                ...item,
                status: 'interrupted',
                error: 'The upload was interrupted before it finished.',
              }
            : item,
        ),
      };
  }
}

/** The file to upload next, or null when the line is empty, busy, or held by a failure. */
export function nextUpload(queue: UploadQueue): string | null {
  const head = queue.items.find((item) => item.status !== 'done');
  return head?.status === 'waiting' ? head.key : null;
}

export interface UploadSummary {
  total: number;
  done: number;
  uploading: number;
  waiting: number;
  /** Failed or interrupted: the ones that need the organizer. */
  needsRetry: number;
  /** Every file is saved on the event. */
  complete: boolean;
  /** Nothing is uploading or able to start: the queue is finished or paused. */
  settled: boolean;
}

export function summarize(queue: UploadQueue): UploadSummary {
  const count = (status: UploadStatus) =>
    queue.items.filter((item) => item.status === status).length;
  const done = count('done');
  const uploading = count('uploading');
  return {
    total: queue.items.length,
    done,
    uploading,
    waiting: count('waiting'),
    needsRetry: count('failed') + count('interrupted'),
    complete: done === queue.items.length,
    settled: uploading === 0 && nextUpload(queue) === null,
  };
}

/** What a file's state says to the organizer, beside its thumbnail. */
export function statusWords(item: UploadItem): string {
  switch (item.status) {
    case 'waiting':
      return 'Waiting';
    case 'uploading':
      return 'Uploading';
    case 'done':
      return 'Uploaded';
    case 'failed':
      return `Not uploaded: ${item.error ?? 'the upload failed.'}`;
    case 'interrupted':
      return 'Not uploaded: the upload was interrupted.';
  }
}

/**
 * Which image in the gallery the server made from this file, by the hash in its URL.
 *
 * Every image path ends `?v=<first 16 hex of the bytes' SHA-256>`. The newest match wins: the
 * file just uploaded is the last one with those bytes.
 */
export function imageIdForHash(
  images: { id: string; path: string }[],
  sha256Hex: string,
): string | null {
  const version = `?v=${sha256Hex.slice(0, 16)}`;
  for (let i = images.length - 1; i >= 0; i -= 1) {
    if (images[i].path.endsWith(version)) return images[i].id;
  }
  return null;
}
