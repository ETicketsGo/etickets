'use client';

import type { KeyboardEvent, MouseEvent } from 'react';
import { Crosshair } from 'lucide-react';
import {
  CENTRE_FOCAL_POINT,
  EVENT_IMAGE_ASPECT,
  focalObjectPosition,
  normaliseFocalPoint,
  type FocalPoint,
} from '@eticketsgo/web-kit';

/** How far one arrow press moves the point: a twentieth of the picture. */
const STEP = 0.05;

/**
 * Which part of the cover stays in view when it is cropped, chosen before the event exists.
 *
 * The edit page has the same control for an uploaded image (`EventImageFocus`), which saves as
 * it goes. Here nothing exists to save to yet, so the point is held with the picture and sent
 * with the same `setImageFocalPoint` call right after the cover is uploaded. The crops beside
 * it, and the live preview, use the API's own crop arithmetic.
 *
 * A focusable picture: click where the important part is, or use the arrow keys.
 */
export function CoverFocus({
  url,
  width,
  height,
  value,
  onChange,
}: {
  url: string;
  width: number;
  height: number;
  value: FocalPoint;
  onChange: (next: FocalPoint) => void;
}) {
  const move = (x: number, y: number) => onChange(normaliseFocalPoint(x, y));
  const click = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    move((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = {
      ArrowLeft: [-STEP, 0],
      ArrowRight: [STEP, 0],
      ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP],
    }[e.key];
    if (!d) return;
    e.preventDefault();
    move(value.x + d[0], value.y + d[1]);
  };
  const centred = value.x === CENTRE_FOCAL_POINT.x && value.y === CENTRE_FOCAL_POINT.y;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-text-primary">Cover focus point</p>
        {!centred ? (
          <button
            type="button"
            onClick={() => onChange(CENTRE_FOCAL_POINT)}
            className="rounded px-1 text-caption font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary"
          >
            Reset to centre
          </button>
        ) : null}
      </div>
      <p id="cover-focus-hint" className="text-caption text-text-muted">
        Click the part that must always show, such as a face or the name. Arrow keys move it too.
      </p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Cover focus point"
          aria-describedby="cover-focus-hint"
          aria-valuetext={`${Math.round(value.x * 100)}% across, ${Math.round(value.y * 100)}% down`}
          aria-valuenow={Math.round(value.x * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          onClick={click}
          onKeyDown={key}
          className="relative mx-auto w-full max-w-xs cursor-crosshair overflow-hidden rounded-md bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="block h-auto max-h-56 w-full object-contain" />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background-surface/90 text-action-primary shadow-md ring-2 ring-action-primary"
            style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }}
          >
            <Crosshair className="h-4 w-4" />
          </span>
        </div>
        <div className="flex gap-2 sm:flex-col">
          {(
            [
              ['Card', EVENT_IMAGE_ASPECT.card, 'aspect-[4/3]'],
              ['Banner', EVENT_IMAGE_ASPECT.banner, 'aspect-video'],
            ] as const
          ).map(([name, aspect, box]) => (
            <figure key={name} className="w-28">
              <div className={`relative overflow-hidden rounded border border-border ${box}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  style={{ objectPosition: focalObjectPosition(width, height, aspect, value) }}
                />
              </div>
              <figcaption className="mt-1 text-caption text-text-muted">{name}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
