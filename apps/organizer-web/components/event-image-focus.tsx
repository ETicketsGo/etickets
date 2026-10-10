'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Crosshair } from 'lucide-react';
import {
  CENTRE_FOCAL_POINT,
  EVENT_IMAGE_ASPECT,
  eventImageSource,
  focalObjectPosition,
  normaliseFocalPoint,
  type FocalPoint,
  type OrgEventImage,
} from '@eticketsgo/web-kit';

/** How long after the last click or key press the point is saved. */
const SAVE_DELAY_MS = 400;
/** How far one arrow key press moves the point: a twentieth of the picture. */
const STEP = 0.05;

/**
 * Where an event image is cropped, chosen by clicking on it, with the crops shown as buyers
 * will see them.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * Cards on browse pages are 4:3 and the banner on the event page is 16:9, whatever shape the
 * organizer uploaded. A crop chosen by the platform alone keeps the middle, which on a portrait
 * poster is often neither the act's face nor its name. The organizer knows which part matters,
 * so they say so here once, and every crop keeps that part in view.
 *
 * ── WHY THE PREVIEW CAN BE TRUSTED ─────────────────────────────────────────────────
 * The two previews are the whole picture in a box of each shape, positioned with
 * `focalObjectPosition` - the same arithmetic the API cuts the real copies with. So what is
 * shown here before saving is what buyers get after it, pixel for pixel, and not an
 * approximation of it.
 *
 * The point moves at once; it is saved a moment after the organizer stops moving it, so a few
 * quick clicks are one save and not a queue of them.
 */
export function EventImageFocus({
  images,
  onSave,
  disabled = false,
  saving = false,
  error,
}: {
  images: OrgEventImage[];
  onSave: (imageId: string, point: FocalPoint) => void;
  disabled?: boolean;
  saving?: boolean;
  error?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const image = images.find((i) => i.id === selectedId) ?? images[0];
  const saved = normaliseFocalPoint(image?.focalPoint?.x, image?.focalPoint?.y);
  const [point, setPoint] = useState<FocalPoint>(saved);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A different image, or the saved point coming back from the API, resets what is shown.
  useEffect(() => {
    setPoint(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image?.id, saved.x, saved.y]);
  useEffect(() => setSize(null), [image?.id]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!image) return null;
  const whole = eventImageSource(image, 'full');
  if (!whole) return null;
  const index = images.indexOf(image);

  const move = (next: FocalPoint) => {
    const clean = normaliseFocalPoint(next.x, next.y);
    setPoint(clean);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSave(image.id, clean), SAVE_DELAY_MS);
  };

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    move({ x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-STEP, 0],
      ArrowRight: [STEP, 0],
      ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    move({ x: point.x + d[0], y: point.y + d[1] });
  };

  const position = (aspect: number) =>
    size ? focalObjectPosition(size.width, size.height, aspect, point) : '50% 50%';
  const atCentre = point.x === CENTRE_FOCAL_POINT.x && point.y === CENTRE_FOCAL_POINT.y;

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-labelledby="focus-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="focus-h" className="text-sm font-medium text-text-primary">
          Focus point
        </h3>
        <span className="text-caption text-text-muted" aria-live="polite">
          {saving ? 'Saving...' : ''}
        </span>
      </div>

      {images.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Image to adjust">
          {images.map((option, i) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={option.id === image.id}
              onClick={() => setSelectedId(option.id)}
              className={`rounded-md border px-2 py-1 text-caption font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                option.id === image.id
                  ? 'border-action-primary bg-tint-primary text-text-primary'
                  : 'border-border text-text-secondary hover:bg-background-subtle'
              }`}
            >
              {i === 0 ? 'Image 1 (cover)' : `Image ${i + 1}`}
            </button>
          ))}
        </div>
      )}

      <p id="focus-hint" className="text-caption text-text-muted">
        Click the part of the picture that must always show, such as a face or the title. Cards and
        the event page banner are cut around it. Arrow keys move it too.
      </p>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex items-center justify-center rounded-md bg-background-subtle p-2">
          <button
            type="button"
            onClick={onClick}
            onKeyDown={onKeyDown}
            disabled={disabled}
            aria-describedby="focus-hint"
            aria-label={`Focal point of image ${index + 1}: ${Math.round(point.x * 100)}% across, ${Math.round(point.y * 100)}% down`}
            className="relative inline-block cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={whole.src}
              alt=""
              draggable={false}
              onLoad={(e) =>
                setSize({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
              className="block max-h-72 w-auto max-w-full select-none"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-black/40 text-white shadow"
              style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            >
              <Crosshair className="h-4 w-4" />
            </span>
          </button>
        </div>

        <div className="space-y-3">
          <figure className="space-y-1">
            <div
              className="aspect-[4/3] w-40 overflow-hidden rounded-md border border-border bg-background-subtle"
              style={{ aspectRatio: EVENT_IMAGE_ASPECT.card }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={whole.src}
                alt="Card preview"
                className="h-full w-full object-cover"
                style={{ objectPosition: position(EVENT_IMAGE_ASPECT.card) }}
              />
            </div>
            <figcaption className="text-caption text-text-muted">Card on browse pages</figcaption>
          </figure>
          <figure className="space-y-1">
            <div
              className="aspect-video w-full overflow-hidden rounded-md border border-border bg-background-subtle"
              style={{ aspectRatio: EVENT_IMAGE_ASPECT.banner }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={whole.src}
                alt="Banner preview"
                className="h-full w-full object-cover"
                style={{ objectPosition: position(EVENT_IMAGE_ASPECT.banner) }}
              />
            </div>
            <figcaption className="text-caption text-text-muted">
              Banner on the event page. Buyers can also open the whole picture.
            </figcaption>
          </figure>
          {!atCentre && !disabled && (
            <button
              type="button"
              onClick={() => move(CENTRE_FOCAL_POINT)}
              className="text-caption font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Reset to the middle
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}
    </section>
  );
}
