'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
import { Button, ImageFrame, portableImageUrl } from '@eticketsgo/web-kit';
import { EVENT_IMAGE_TYPES, prepareEventImage } from '@/components/event-image-picker';

/**
 * A film's poster, chosen from the organizer's computer.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * Walking QA (2026-10-15): the only way to give a film a poster was a "Poster URL" field, so an
 * organizer had to host the picture somewhere else first and paste its address. Every other
 * picture in the console is uploaded. The link still works - a distributor's poster address is
 * a real case - but it is the second way, not the only one.
 *
 * The picture is scaled down in the browser first (the same preparation as event images), and
 * the API checks and re-cuts whatever arrives, because a browser is not a security boundary.
 */
export function PosterPicker({
  src,
  title,
  busy = false,
  error,
  onPick,
  linkField,
}: {
  /** The poster now: a stored URL, or a preview of a picked file. */
  src: string | null;
  title: string;
  busy?: boolean;
  /** Why the last pick or upload failed, from here or from the API. */
  error?: string | null;
  /** A prepared JPEG, ready to upload, and a URL the page can show it from meanwhile. */
  onPick: (image: Blob, previewUrl: string) => void;
  /** The "paste a link" field, shown folded under the picker. */
  linkField?: ReactNode;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = error ?? problem;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    try {
      const prepared = await prepareEventImage(file);
      onPick(prepared, URL.createObjectURL(prepared));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That file could not be used.');
    } finally {
      // Picking the same file again after a failure must fire a change.
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-[0.8125rem] font-medium text-text-secondary">Poster</p>
      <div className="flex items-start gap-4">
        <div className="relative w-24 shrink-0">
          <ImageFrame
            src={portableImageUrl(src)}
            alt={src ? `Poster for ${title || 'this film'}` : ''}
            ratio="2:3"
            category="movie"
            rounded="md"
            placeholderLabel="No poster"
          />
          {busy ? (
            <span className="absolute inset-0 flex items-center justify-center rounded-md bg-background-surface/70">
              <Loader2 className="h-5 w-5 animate-spin text-text-secondary" aria-hidden />
            </span>
          ) : null}
        </div>
        <div className="min-w-0 space-y-2">
          <input
            ref={input}
            id={inputId}
            type="file"
            accept={EVENT_IMAGE_TYPES.join(',')}
            className="sr-only"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          <Button
            variant="outline"
            size="sm"
            icon={ImagePlus}
            loading={busy}
            onClick={() => input.current?.click()}
          >
            {src ? 'Change poster' : 'Add poster'}
          </Button>
          <p className="text-caption text-text-muted">
            JPG, PNG or WebP from your computer. A tall picture (2 by 3) fits best.
          </p>
          {shown ? (
            <p role="alert" className="text-caption text-status-error">
              {shown}
            </p>
          ) : null}
        </div>
      </div>
      {linkField ? (
        <details className="group">
          <summary className="cursor-pointer text-caption font-medium text-text-secondary hover:text-text-primary">
            Use a link to an image instead
          </summary>
          <div className="mt-2">{linkField}</div>
        </details>
      ) : null}
    </div>
  );
}
