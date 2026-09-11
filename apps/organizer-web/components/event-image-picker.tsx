'use client';

import { useId, useRef } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus } from 'lucide-react';
import { Button } from '@eticketsgo/web-kit';

/** What the picker offers, and what the API will recognise from the bytes. */
export const EVENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** The API's limit per event; mirrored so the console can say so before an upload is refused. */
export const EVENT_IMAGE_MAX_COUNT = 10;
const MAX_EDGE = 1600;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The organizer's photo, made fit to upload — in the browser, before it leaves.
 *
 * A phone photo is 4000px and 5 MB. Nobody sees more than 1600px of it on an event card or a
 * hero, and uploading the rest costs the organizer their data plan and the platform its
 * database. So it is scaled down and re-encoded as JPEG here; the API still checks what
 * arrives, because a browser is not a security boundary.
 *
 * Transparent areas are painted white, since JPEG has no transparency and would otherwise
 * render them black.
 */
export async function prepareEventImage(file: Blob): Promise<Blob> {
  if (!EVENT_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Choose a JPG, PNG or WebP image.');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as an image.');
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the image.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of [0.86, 0.75, 0.6]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('That image is too large even after resizing. Try a smaller one.');
}

/** One image as the editor shows it: something to key it by, and something to display. */
export interface GalleryTile {
  key: string;
  url: string;
}

const ICON_BUTTON =
  'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-background-subtle hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const TEXT_BUTTON =
  'inline-flex h-8 items-center rounded-md px-2 text-caption font-medium text-text-secondary hover:bg-background-subtle hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

/**
 * An event's images: add several, remove any, put them in order, and choose the cover.
 *
 * ── THE FIRST IMAGE IS THE COVER ───────────────────────────────────────────────────
 * One rule instead of a separate "cover" flag that could point at an image since deleted. The
 * cover is what browse shows on the card and what the event page opens on; the rest are the
 * gallery beneath it. "Make cover" moves an image to the front; the arrows move it one place.
 *
 * Presentational: the caller decides whether a change is saved at once (an event that exists)
 * or held until the event is created (the wizard).
 */
export function EventGalleryEditor({
  tiles,
  onAdd,
  onRemove,
  onReorder,
  disabled = false,
  busy = false,
  error,
  note,
  max = EVENT_IMAGE_MAX_COUNT,
}: {
  tiles: GalleryTile[];
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
  onReorder: (keys: string[]) => void;
  disabled?: boolean;
  busy?: boolean;
  error?: string | null;
  note?: string | null;
  max?: number;
}) {
  const inputId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const full = tiles.length >= max;
  const locked = disabled || busy;

  const move = (from: number, to: number) => {
    const keys = tiles.map((tile) => tile.key);
    const [moved] = keys.splice(from, 1);
    keys.splice(to, 0, moved);
    onReorder(keys);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="block text-sm font-medium text-text-primary">
          Event images <span className="font-normal text-text-muted">(optional)</span>
        </label>
        <span className="text-caption text-text-muted">
          {tiles.length} of {max}
        </span>
      </div>

      {tiles.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {tiles.map((tile, index) => {
            const n = index + 1;
            return (
              <li
                key={tile.key}
                className="overflow-hidden rounded-md border border-border bg-background-surface"
              >
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={tile.url}
                    alt={`Event image ${n} of ${tiles.length}${index === 0 ? ', the cover' : ''}`}
                    className="aspect-video w-full object-cover"
                  />
                  {index === 0 && (
                    <span className="absolute left-2 top-2 rounded bg-black/75 px-1.5 py-0.5 text-caption font-medium text-white">
                      Cover
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1 p-1.5">
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Move image ${n} earlier`}
                    disabled={locked || index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Move image ${n} later`}
                    disabled={locked || index === tiles.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </button>
                  {index > 0 && (
                    <button
                      type="button"
                      className={TEXT_BUTTON}
                      aria-label={`Make cover: image ${n}`}
                      disabled={locked}
                      onClick={() => move(index, 0)}
                    >
                      Make cover
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${TEXT_BUTTON} ml-auto text-status-error`}
                    aria-label={`Remove image ${n}`}
                    disabled={locked}
                    onClick={() => onRemove(tile.key)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex aspect-[3/1] w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-background-subtle text-text-muted">
          <ImagePlus className="h-8 w-8" aria-hidden />
          <span className="text-sm">No images yet</span>
        </div>
      )}

      <input
        ref={input}
        id={inputId}
        type="file"
        multiple
        accept={EVENT_IMAGE_TYPES.join(',')}
        aria-label="Event images"
        aria-describedby={hintId}
        className="sr-only"
        disabled={locked || full}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Cleared so the same file can be chosen again after it was removed.
          e.target.value = '';
          if (files.length) onAdd(files);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={busy}
        disabled={disabled || full}
        onClick={() => input.current?.click()}
      >
        {full ? `${max} images added` : tiles.length ? 'Add more images' : 'Add images'}
      </Button>
      <p id={hintId} className="text-caption text-text-muted">
        Up to {max}. The first image is the cover — shown on cards and at the top of your event
        page. JPG, PNG or WebP; wide images work best (16:9, at least 1200 × 675).
      </p>
      {note && <p className="text-caption text-text-secondary">{note}</p>}
      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}
