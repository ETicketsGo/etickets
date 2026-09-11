'use client';

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * An event's images, full screen.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * Reported from QA: "images are not coming properly on the event when a user selects it". The
 * hero is a wide strip, and a poster or a logo cropped to fit it loses its edges — the one
 * place a buyer looks closely at a picture showed them part of it. Here each image is shown
 * whole, as large as the screen allows.
 *
 * ── HOW IT BEHAVES ─────────────────────────────────────────────────────────────────
 * A modal dialog: focus moves in and is kept in, Escape closes, the page behind stops
 * scrolling, and focus returns to what opened it. Arrow keys and a horizontal swipe move
 * between images; the counter is announced as it changes. Nothing advances on its own.
 */
export function ImageLightbox({
  images,
  index,
  title,
  onIndexChange,
  onClose,
}: {
  images: string[];
  /** Which image is open, or null when the viewer is closed. */
  index: number | null;
  title: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations('storefront.event');
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const touchStartX = useRef<number | null>(null);
  const open = index !== null;
  const count = images.length;

  const go = (delta: number) => {
    if (index === null || count < 2) return;
    onIndexChange((index + delta + count) % count);
  };
  // The latest navigation, for listeners registered once per opening.
  const goRef = useRef(go);
  goRef.current = go;
  const closeRefFn = useRef(onClose);
  closeRefFn.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRefFn.current();
      else if (e.key === 'ArrowRight') goRef.current(1);
      else if (e.key === 'ArrowLeft') goRef.current(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      openerRef.current?.focus?.();
    };
  }, [open]);

  const trapFocus = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (index === null || count === 0) return null;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const navButton =
    'absolute top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white';

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={trapFocus}
      onClick={onClose}
      onTouchStart={(e) => {
        touchStartX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        if (start === null) return;
        const dx = (e.changedTouches[0]?.clientX ?? start) - start;
        if (Math.abs(dx) > 48) go(dx < 0 ? 1 : -1);
      }}
      className="fixed inset-0 z-[80] flex flex-col bg-black/95 text-white"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3" onClick={stop}>
        <p className="min-w-0 truncate text-sm">
          <span className="font-medium">{title}</span>
          {count > 1 && (
            <span className="ml-2 tabular-nums text-white/70" aria-live="polite">
              {t('galleryCounter', { index: index + 1, total: count })}
            </span>
          )}
        </p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={t('galleryClose')}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-3 sm:px-20">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={images[index]}
          src={images[index]}
          alt={t('galleryImageAlt', { title, index: index + 1, total: count })}
          draggable={false}
          onClick={stop}
          className="max-h-full max-w-full animate-fade-in select-none rounded-md object-contain"
        />
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                go(-1);
              }}
              aria-label={t('galleryPrevious')}
              className={`${navButton} left-3`}
            >
              <ChevronLeft className="h-6 w-6" aria-hidden />
            </button>
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                go(1);
              }}
              aria-label={t('galleryNext')}
              className={`${navButton} right-3`}
            >
              <ChevronRight className="h-6 w-6" aria-hidden />
            </button>
          </>
        )}
      </div>

      {count > 1 && (
        <ul
          className="flex justify-center gap-2 overflow-x-auto px-4 pb-4"
          onClick={stop}
          aria-label={t('galleryLabel')}
        >
          {images.map((url, i) => (
            <li key={url} className="shrink-0">
              <button
                type="button"
                onClick={() => onIndexChange(i)}
                aria-current={i === index ? 'true' : undefined}
                aria-label={t('galleryShow', { index: i + 1, total: count })}
                className={`block overflow-hidden rounded border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                  i === index ? 'border-white' : 'border-transparent opacity-60 hover:opacity-100'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-12 w-20 object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
