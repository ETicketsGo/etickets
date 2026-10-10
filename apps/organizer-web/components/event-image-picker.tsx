'use client';

import { useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  Loader2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { Button, FOCUS_RING, IconButton, IconTile } from '@eticketsgo/web-kit';

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

/**
 * An event's images: add several — by picking or by dropping them — remove any, put them in
 * order, and choose the cover.
 *
 * ── THE FIRST IMAGE IS THE COVER ───────────────────────────────────────────────────
 * One rule instead of a separate "cover" flag that could point at an image since deleted. The
 * cover is what browse shows on the card and what the event page opens on; the rest are the
 * gallery beneath it. "Make cover" (the star) moves an image to the front; the arrows move it one
 * place. The cover tile is outlined and badged, so which one it is never needs reading.
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
  /* Said when a dropped or picked file is not a picture we take, instead of ignoring it. */
  const [skipped, setSkipped] = useState<string | null>(null);
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
    const left = files.length - images.length;
    setSkipped(
      left > 0
        ? `${left === 1 ? 'One file was' : `${left} files were`} not added: only JPG, PNG or WebP images can be used.`
        : null,
    );
    if (images.length) onAdd(images);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="block text-sm font-medium text-text-primary">
          Event images <span className="font-normal text-text-muted">(optional)</span>
        </label>
        <span className="text-caption tabular-nums text-text-muted" aria-live="polite">
          {ready.length} of {max}
          {uploading > 0 ? ` · uploading ${uploading}` : ''}
        </span>
      </div>

      {/*
        ── ONE COMPACT DROP AREA ───────────────────────────────────────────────────────
        This was a tall dashed box (a third of the column's width high) with "choose them below"
        and the button underneath it: on a phone the first thing on the step was an empty frame.
        Now an empty picker is one short row with the button IN it, and a filled one is the
        thumbnails with an "Add" tile at the end - the whole area still takes a drop.
      */}
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
        className={`rounded-lg transition-colors ${
          dragging ? 'bg-tint-primary ring-2 ring-action-primary ring-offset-2' : ''
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
                  className={`overflow-hidden rounded-lg border bg-background-surface shadow-xs ${
                    saved && index === 0 ? 'border-action-primary' : 'border-border'
                  }`}
                >
                  <div className="relative aspect-video bg-background-subtle">
                    {/*
                      Cover-cropped like the card buyers see, not letterboxed: a thumbnail with
                      grey bars above and below read as a broken upload.
                    */}
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
                      className={`absolute inset-0 h-full w-full object-cover ${saved ? '' : 'opacity-40'}`}
                    />
                    {saved ? (
                      <span
                        aria-hidden="true"
                        className={`absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro font-semibold shadow-xs ${
                          index === 0
                            ? 'bg-action-primary text-action-primary-foreground'
                            : 'bg-background-surface/90 text-text-primary'
                        }`}
                      >
                        {index === 0 ? (
                          <>
                            <Star className="h-3 w-3" aria-hidden />
                            Cover
                          </>
                        ) : (
                          n
                        )}
                      </span>
                    ) : null}
                    {tile.status === 'uploading' && (
                      <span className="absolute inset-0 flex items-center justify-center gap-2 text-caption font-medium text-text-primary">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        Uploading...
                      </span>
                    )}
                    {tile.status === 'failed' && (
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-tint-error/90 p-2 text-center text-caption font-medium text-status-error">
                        <AlertTriangle className="h-4 w-4" aria-hidden />
                        {tile.error ?? 'Not uploaded'}
                      </span>
                    )}
                  </div>
                  {/*
                    One row of square buttons with names, so a tile never wraps onto a second
                    and third line ("Make cover" and "Remove" used to stack on a phone).
                  */}
                  <div className="flex items-center gap-0.5 p-1">
                    {saved && (
                      <>
                        <IconButton
                          label={`Move image ${n} earlier`}
                          icon={ArrowLeft}
                          size="sm"
                          disabled={locked || index === 0}
                          onClick={() => move(index, index - 1)}
                        />
                        <IconButton
                          label={`Move image ${n} later`}
                          icon={ArrowRight}
                          size="sm"
                          disabled={locked || index === ready.length - 1}
                          onClick={() => move(index, index + 1)}
                        />
                        {index > 0 && (
                          <IconButton
                            label={`Make cover: image ${n}`}
                            icon={Star}
                            size="sm"
                            disabled={locked}
                            onClick={() => move(index, 0)}
                          />
                        )}
                      </>
                    )}
                    {tile.status !== 'uploading' && (
                      <IconButton
                        label={saved ? `Remove image ${n}` : 'Dismiss image that was not uploaded'}
                        icon={saved ? Trash2 : X}
                        variant="danger"
                        size="sm"
                        className="ml-auto"
                        disabled={saved && locked}
                        onClick={() => onRemove(tile.key)}
                      />
                    )}
                  </div>
                </li>
              );
            })}
            {!full && !disabled ? (
              <li>
                <button
                  type="button"
                  onClick={() => input.current?.click()}
                  className={`flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong bg-background-subtle text-caption font-medium text-text-secondary transition-colors hover:border-action-primary hover:text-text-primary ${FOCUS_RING}`}
                >
                  <ImagePlus className="h-5 w-5" aria-hidden />
                  Add more images
                </button>
              </li>
            ) : null}
          </ul>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-border-strong bg-background-subtle px-3 py-3">
            <IconTile icon={ImagePlus} tone="blue" size="sm" />
            <p className="min-w-0 flex-1 text-caption text-text-secondary">
              <span className="block font-medium text-text-primary">Add a cover image</span>
              <span className="hidden sm:inline">Drag pictures here. </span>A wide one works best.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => input.current?.click()}
            >
              Choose images
            </Button>
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
      <p id={hintId} className="text-caption text-text-muted">
        {full
          ? `${max} images added, the most an event can have.`
          : `The first image is the cover on cards and the event page. JPG, PNG or WebP, up to ${max}.`}
      </p>
      {note && <p className="text-caption text-text-secondary">{note}</p>}
      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}
      {skipped && (
        <p role="alert" className="text-caption text-status-error">
          {skipped}
        </p>
      )}
    </div>
  );
}
