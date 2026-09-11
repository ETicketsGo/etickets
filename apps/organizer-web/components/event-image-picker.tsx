'use client';

import { useId, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, ImagePlus, Loader2 } from 'lucide-react';
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

/**
 * One image as the editor shows it.
 *
 * `status` is absent for an image that is saved (or, in the wizard, ready to save). An image
 * still going up is `uploading`, shown at once from the organizer's own file so they see what
 * they picked straight away; one that was refused is `failed`, with the reason on the tile.
 */
export interface GalleryTile {
  key: string;
  url: string;
  status?: 'uploading' | 'failed';
  error?: string;
}

const ICON_BUTTON =
  'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-background-subtle hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const TEXT_BUTTON =
  'inline-flex h-8 items-center rounded-md px-2 text-caption font-medium text-text-secondary hover:bg-background-subtle hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

/**
 * An event's images: add several — by picking or by dropping them — remove any, put them in
 * order, and choose the cover.
 *
 * ── THE FIRST IMAGE IS THE COVER ───────────────────────────────────────────────────
 * One rule instead of a separate "cover" flag that could point at an image since deleted. The
 * cover is what browse shows on the card and what the event page opens on; the rest are the
 * gallery beneath it. "Make cover" moves an image to the front; the arrows move it one place.
 *
 * ── WHAT UPLOADING LOOKS LIKE ──────────────────────────────────────────────────────
 * A picked image appears as a tile immediately, marked "Uploading…", and becomes an ordinary
 * tile when it is saved; a refused one stays, marked with why, until it is removed. Nothing
 * disappears into a spinner on a button with no sign of which files are going where.
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
  const [dragging, setDragging] = useState(false);
  const ready = tiles.filter((tile) => !tile.status);
  const uploading = tiles.filter((tile) => tile.status === 'uploading').length;
  const full = ready.length + uploading >= max;
  const locked = disabled || busy;

  const move = (from: number, to: number) => {
    const keys = ready.map((tile) => tile.key);
    const [moved] = keys.splice(from, 1);
    keys.splice(to, 0, moved);
    onReorder(keys);
  };

  const accept = (files: File[]) => {
    const images = files.filter((file) => EVENT_IMAGE_TYPES.includes(file.type));
    if (images.length) onAdd(images);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="block text-sm font-medium text-text-primary">
          Event images <span className="font-normal text-text-muted">(optional)</span>
        </label>
        <span className="text-caption text-text-muted" aria-live="polite">
          {ready.length} of {max}
          {uploading > 0 ? ` · uploading ${uploading}` : ''}
        </span>
      </div>

      <div
        onDragOver={(e) => {
          if (disabled || full) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled || full) return;
          accept(Array.from(e.dataTransfer.files));
        }}
        className={`rounded-md border-2 border-dashed p-2 transition-colors ${
          dragging ? 'border-action-primary bg-tint-primary' : 'border-border'
        }`}
      >
        {tiles.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tiles.map((tile) => {
              const index = ready.indexOf(tile);
              const n = index + 1;
              const saved = !tile.status;
              return (
                <li
                  key={tile.key}
                  className="overflow-hidden rounded-md border border-border bg-background-surface"
                >
                  <div className="relative bg-background-subtle">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={tile.url}
                      alt={
                        saved
                          ? `Event image ${n} of ${ready.length}${index === 0 ? ', the cover' : ''}`
                          : tile.status === 'uploading'
                            ? 'Image uploading'
                            : 'Image not uploaded'
                      }
                      className={`aspect-video w-full object-contain ${saved ? '' : 'opacity-50'}`}
                    />
                    {saved && index === 0 && (
                      <span className="absolute left-2 top-2 rounded bg-black/75 px-1.5 py-0.5 text-caption font-medium text-white">
                        Cover
                      </span>
                    )}
                    {tile.status === 'uploading' && (
                      <span className="absolute inset-0 flex items-center justify-center gap-2 text-caption font-medium text-text-primary">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        Uploading…
                      </span>
                    )}
                    {tile.status === 'failed' && (
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-status-error/10 p-2 text-center text-caption text-status-error">
                        <AlertTriangle className="h-4 w-4" aria-hidden />
                        {tile.error ?? 'Not uploaded'}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 p-1.5">
                    {saved && (
                      <>
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
                          disabled={locked || index === ready.length - 1}
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
                      </>
                    )}
                    {tile.status !== 'uploading' && (
                      <button
                        type="button"
                        className={`${TEXT_BUTTON} ml-auto text-status-error`}
                        aria-label={
                          saved ? `Remove image ${n}` : 'Dismiss image that was not uploaded'
                        }
                        disabled={saved && locked}
                        onClick={() => onRemove(tile.key)}
                      >
                        {saved ? 'Remove' : 'Dismiss'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex aspect-[3/1] w-full flex-col items-center justify-center gap-2 text-center text-text-muted">
            <ImagePlus className="h-8 w-8" aria-hidden />
            <span className="text-sm">Drag images here, or choose them below</span>
          </div>
        )}
      </div>

      <input
        ref={input}
        id={inputId}
        type="file"
        multiple
        accept={EVENT_IMAGE_TYPES.join(',')}
        aria-label="Event images"
        aria-describedby={hintId}
        className="sr-only"
        disabled={disabled || full}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Cleared so the same file can be chosen again after it was removed.
          e.target.value = '';
          accept(files);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || full}
        onClick={() => input.current?.click()}
      >
        {full ? `${max} images added` : ready.length ? 'Add more images' : 'Choose images'}
      </Button>
      <p id={hintId} className="text-caption text-text-muted">
        Up to {max}. The first image is the cover — shown on cards and at the top of your event
        page, shown whole rather than cropped. JPG, PNG or WebP; drag several in at once.
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
