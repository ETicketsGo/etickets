'use client';

import { useEffect, useId, useRef } from 'react';
import { ImagePlus } from 'lucide-react';
import { Button } from '@eticketsgo/web-kit';

/** What the picker offers, and what the API will recognise from the bytes. */
export const EVENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
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
 * Choose, preview, replace or remove the event's image.
 *
 * Presentational: the caller decides whether a pick uploads now (editing an event that
 * exists) or waits for the event to be created (the wizard).
 */
export function EventImagePicker({
  previewUrl,
  onPick,
  onClear,
  disabled = false,
  busy = false,
  error,
  note,
}: {
  previewUrl: string | null;
  onPick: (file: File) => void;
  onClear?: () => void;
  disabled?: boolean;
  busy?: boolean;
  error?: string | null;
  note?: string | null;
}) {
  const inputId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);

  // Let the same file be picked again after it was removed.
  useEffect(() => {
    if (!previewUrl && input.current) input.current.value = '';
  }, [previewUrl]);

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium text-text-primary">
        Event image <span className="font-normal text-text-muted">(optional)</span>
      </label>
      <div className="overflow-hidden rounded-md border border-border bg-background-subtle">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Event image preview"
            className="aspect-video w-full object-cover"
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 text-text-muted">
            <ImagePlus className="h-8 w-8" aria-hidden />
            <span className="text-sm">No image yet</span>
          </div>
        )}
      </div>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept={EVENT_IMAGE_TYPES.join(',')}
        aria-label="Event image"
        aria-describedby={hintId}
        className="sr-only"
        disabled={disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={busy}
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          {previewUrl ? 'Replace image' : 'Choose image'}
        </Button>
        {previewUrl && onClear && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onClick={onClear}
          >
            Remove
          </Button>
        )}
      </div>
      <p id={hintId} className="text-caption text-text-muted">
        JPG, PNG or WebP. A wide image works best (16:9, at least 1200 × 675). Shown on your event
        page and wherever the event is listed.
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
