'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { Button, api, errorMessage } from '@eticketsgo/web-kit';
import { imageOutbox, type ImageOutbox } from '@/lib/image-outbox';
import { statusWords, summarize, type UploadItem, type UploadQueue } from '@/lib/image-uploads';

/** The tab's one image outbox, sending through the same API calls the edit page uses. */
export function eventImageOutbox(): ImageOutbox {
  return imageOutbox(() => ({
    addImage: (eventId, blob, key) => api.events.addImage(eventId, blob, 'event-image.jpg', key),
    setFocalPoint: (eventId, imageId, point) =>
      api.events.setImageFocalPoint(eventId, imageId, point),
    describeError: errorMessage,
  }));
}

const NO_QUEUE = () => undefined;

/** The event's image queue on this device, kept current, or undefined when there is none. */
export function useImageUploads(eventId: string | null): UploadQueue | undefined {
  const outbox = eventImageOutbox();
  const queue = useSyncExternalStore(
    outbox.subscribe,
    () => (eventId ? outbox.snapshot(eventId) : undefined),
    NO_QUEUE,
  );
  useEffect(() => {
    if (eventId) void outbox.load(eventId);
  }, [eventId, outbox]);
  return queue;
}

function StatusIcon({ item }: { item: UploadItem }) {
  const cls = 'h-4 w-4 shrink-0';
  switch (item.status) {
    case 'done':
      return <CheckCircle2 className={`${cls} text-status-success`} aria-hidden />;
    case 'uploading':
      return <Loader2 className={`${cls} animate-spin text-text-secondary`} aria-hidden />;
    case 'waiting':
      return <Clock className={`${cls} text-text-muted`} aria-hidden />;
    default:
      return <AlertTriangle className={`${cls} text-status-error`} aria-hidden />;
  }
}

/**
 * One row per picked file: its thumbnail, its place (the first is the cover), and where it is.
 * The thumbnail is the organizer's own copy on this device, so a file that never reached the
 * server is still recognisable.
 */
export function ImageUploadList({ queue }: { queue: UploadQueue }) {
  const outbox = eventImageOutbox();
  const keys = queue.items.map((item) => item.key).join('|');
  /*
    Made and revoked in ONE effect. Made in a memo and revoked in an effect's cleanup, a
    development re-run of the effect revoked URLs the memo then handed out again: every
    thumbnail drew as a broken image.
  */
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    const map = new Map<string, string>();
    for (const key of keys.split('|')) {
      const blob = key ? outbox.blob(key) : undefined;
      if (blob) map.set(key, URL.createObjectURL(blob));
    }
    setUrls(map);
    return () => map.forEach((url) => URL.revokeObjectURL(url));
    // Keyed by the files, not the statuses: a status change must not reload every thumbnail.
  }, [keys, outbox]);

  return (
    <ul className="space-y-2" aria-label="Images">
      {queue.items.map((item, index) => {
        const url = urls.get(item.key);
        const name = `Image ${index + 1}${index === 0 ? ' (cover)' : ''}`;
        const words = statusWords(item);
        return (
          <li
            key={item.key}
            className="flex items-center gap-3 rounded-lg border border-border bg-background-surface p-2"
          >
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt=""
                className="h-10 w-16 shrink-0 rounded object-cover"
                aria-hidden
              />
            ) : (
              <span className="h-10 w-16 shrink-0 rounded bg-background-subtle" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary">{name}</p>
              <p
                className={`flex items-center gap-1.5 text-caption ${
                  item.status === 'failed' || item.status === 'interrupted'
                    ? 'text-status-error'
                    : 'text-text-secondary'
                }`}
              >
                <StatusIcon item={item} />
                <span className="min-w-0 break-words">{words}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** "2 of 3 images uploaded", said once per change to a screen reader. */
export function uploadProgressWords(queue: UploadQueue): string {
  const s = summarize(queue);
  return `${s.done} of ${s.total} image${s.total === 1 ? '' : 's'} uploaded`;
}

/**
 * Images picked for this event that are not on it yet - shown on the event's own pages.
 *
 * Appears only on the device that holds them, and only while there is something to say: an
 * upload still going (the organizer left the wizard while it ran), or files that failed or were
 * cut off by a reload, with Retry. Once every file is on the event it refreshes the page's data
 * and goes away.
 */
export function PendingImageUploads({
  eventId,
  onUploaded,
}: {
  eventId: string;
  onUploaded: () => void;
}) {
  const outbox = eventImageOutbox();
  const queue = useImageUploads(eventId);
  const summary = queue ? summarize(queue) : null;
  const complete = summary?.complete ?? false;

  useEffect(() => {
    if (!complete) return;
    onUploaded();
    outbox.clearDone(eventId);
    // `onUploaded` is a fresh closure each render; only the moment of completion matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complete, eventId, outbox]);

  if (!queue || !summary || summary.total === 0 || complete) return null;
  const stuck = summary.settled && summary.needsRetry > 0;
  const missing = summary.total - summary.done;

  return (
    <section
      aria-labelledby={`pending-images-${eventId}`}
      className={`rounded-2xl border p-4 ${
        stuck ? 'border-status-error/30 bg-tint-error' : 'border-border bg-background-surface'
      }`}
    >
      <h2 id={`pending-images-${eventId}`} className="text-sm font-semibold text-text-primary">
        {stuck
          ? `${missing} image${missing === 1 ? ' is' : 's are'} not on this event yet`
          : 'Adding images to this event'}
      </h2>
      <p className="mt-1 text-caption text-text-secondary" aria-live="polite">
        {stuck
          ? 'The upload did not finish. The pictures are kept on this device only, so retry from here.'
          : `${uploadProgressWords(queue)}. Keep this tab open until it finishes.`}
      </p>
      <div className="mt-3">
        <ImageUploadList queue={queue} />
      </div>
      {stuck && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void outbox.retry(eventId)}>
            Retry upload
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void outbox.dismissAll(eventId)}>
            Discard these images
          </Button>
        </div>
      )}
    </section>
  );
}
