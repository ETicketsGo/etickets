'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Lock, Sun, WifiOff, X } from 'lucide-react';
import {
  BRAND_FOCUS,
  BrandStatusPill,
  brandButtonClasses,
  eventTiming,
  useCountdown,
  useWakeLock,
  type BookingGroup,
  type BrandStatus,
  type WalletTicket,
} from '@eticketsgo/web-kit';
import { useFormat } from '@/lib/format';
import { useStatusLabel } from '@/lib/status-label';

/** The placeholder drawn when a QR image fails, in the reader's language. */
function qrFallback(title: string, hint: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#f8fafc"/><text x="120" y="122" font-family="sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">${esc(title)}</text><text x="120" y="144" font-family="sans-serif" font-size="10" fill="#94a3b8" text-anchor="middle">${esc(hint)}</text></svg>`,
    )
  );
}

/** A ticket's state as the brand's pill, as on the ticket pages. Words always. */
const TICKET_TONE: Record<string, BrandStatus> = {
  ACTIVE: 'positive',
  CHECKED_IN: 'info',
  TRANSFERRED: 'neutral',
  REFUNDED: 'neutral',
  CANCELLED: 'critical',
  VOID: 'critical',
};

const BRIGHTNESS_KEY = 'etg_brightness_tip_dismissed';
const SWIPE = 48;

/**
 * Full-screen, boarding-pass style Event Day Mode, on the brand's paper (it opens from the
 * booking's ticket page, which is on the brand layer, and takes its tokens from there).
 * The QR stays on pure white for the scanner. Reuses the same tickets/QRs as
 * the viewer — it's a presentation layer, not new data. State-driven (not a route)
 * so there's no accidental navigation away; Escape or the close button exits.
 */
export function EventDayMode({
  group,
  tickets,
  index,
  onNavigate,
  onExit,
  online,
  syncedAt,
}: {
  group: BookingGroup;
  tickets: WalletTicket[];
  index: number;
  onNavigate: (next: number) => void;
  onExit: () => void;
  online: boolean;
  syncedAt?: number | null;
}) {
  const current = tickets[index];
  const e = useTranslations('storefront.eventDay');
  const b = useTranslations('storefront.bookingTickets');
  const { dateTime, zoneAbbrev } = useFormat();
  const statusLabel = useStatusLabel();
  const wake = useWakeLock(true);
  const countdown = useCountdown(current?.startsAt);
  const dialogRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const [showBrightnessTip, setShowBrightnessTip] = useState(false);
  useEffect(() => {
    try {
      setShowBrightnessTip(window.localStorage.getItem(BRIGHTNESS_KEY) !== '1');
    } catch {
      setShowBrightnessTip(true);
    }
  }, []);
  const dismissBrightnessTip = () => {
    setShowBrightnessTip(false);
    try {
      window.localStorage.setItem(BRIGHTNESS_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  // Focus the dialog, lock body scroll, and wire Escape + arrows.
  useEffect(() => {
    dialogRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
      else if (e.key === 'ArrowRight') onNavigate(index + 1);
      else if (e.key === 'ArrowLeft') onNavigate(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, onExit, onNavigate]);

  if (!current) return null;

  const timing = eventTiming(current.startsAt, Date.now());
  const seat = current.seatLabel;
  const place = group.isMovie
    ? [group.cinemaName, group.screenName].filter(Boolean).join(' - ')
    : group.venueName;
  const fallback = qrFallback(b('qrUnavailable'), b('qrUseTicketId'));

  const onTouchStart = (ev: React.TouchEvent) => {
    const t = ev.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (ev: React.TouchEvent) => {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - s.x;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(t.clientY - s.y)) {
      onNavigate(dx < 0 ? index + 1 : index - 1);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={e('dialogLabel', {
        title: group.title,
        index: index + 1,
        total: tickets.length,
      })}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex flex-col bg-brand-canvas font-brand-text text-brand-ink focus:outline-none"
      style={{ touchAction: 'pan-y' }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Top bar */}
      <header className="flex items-center justify-between gap-3 border-b border-brand-line px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-brand-display text-brand-card text-brand-ink">
            {group.title}
          </p>
          <p className="font-mono text-brand-meta text-brand-ink-3">{group.bookingRef}</p>
        </div>
        <button
          onClick={onExit}
          type="button"
          aria-label={e('exit')}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-brand-ink-2 transition-colors duration-150 hover:bg-brand-sunken hover:text-brand-ink ${BRAND_FOCUS}`}
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </header>

      {/* Status strip: offline + wake-lock + brightness tip */}
      <div className="space-y-px">
        {!online && (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col items-center gap-0.5 bg-brand-caution-tint px-4 py-1.5 text-center text-brand-meta font-semibold text-brand-caution"
          >
            <span className="flex items-center gap-2">
              <WifiOff className="h-3.5 w-3.5" aria-hidden />{' '}
              {e('offlineVerified', {
                when: syncedAt ? dateTime(new Date(syncedAt)) : e('offlineEarlier'),
              })}
            </span>
            <span className="font-normal">{e('offlineNote')}</span>
          </div>
        )}
        {showBrightnessTip && (
          <div className="flex items-center justify-between gap-3 bg-brand-sunken px-4 py-2 text-brand-meta text-brand-ink-2">
            <span className="flex items-center gap-2">
              <Sun className="h-4 w-4 shrink-0 text-brand-caution" aria-hidden />
              {e('brightnessTip')}
            </span>
            <button
              type="button"
              onClick={dismissBrightnessTip}
              className={`${brandButtonClasses('quiet', 'sm')} shrink-0`}
            >
              {e('gotIt')}
            </button>
          </div>
        )}
      </div>

      {/* Main — portrait: column; landscape: QR beside details */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-5 landscape:flex-row landscape:gap-10">
        {/* QR */}
        <div className="flex flex-col items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={current.id}
            // A vendor barcode the server cannot draw arrives as null: show the fallback.
            src={current.qrDataUrl ?? fallback}
            alt={b('qrAlt', { serial: current.serial })}
            onError={(ev) => {
              const img = ev.currentTarget;
              if (img.src !== fallback) img.src = fallback;
            }}
            className="rounded-brand-card border border-brand-line bg-white p-3"
            style={{ width: 'min(78vw, 58vh)', height: 'min(78vw, 58vh)' }}
          />
          <p className="mt-3 font-mono text-brand-ui text-brand-ink-2">{current.serial}</p>
        </div>

        {/* Details */}
        <div className="w-full max-w-sm text-center landscape:text-left">
          <p className="text-brand-eyebrow uppercase text-brand-ink-3">
            {b('ticketOf', { index: index + 1, total: tickets.length })}
          </p>

          {/* Countdown */}
          <div className="mt-2">
            {timing.phase === 'ended' ? (
              <p className="font-brand-display text-brand-d3 text-brand-ink-2">{e('ended')}</p>
            ) : timing.phase === 'live' ? (
              <p className="font-brand-display text-brand-d3 text-brand-positive">{e('live')}</p>
            ) : (
              <div>
                <p className="text-brand-eyebrow uppercase text-brand-ink-3">
                  {e(`phase.${timing.phase}`)}
                </p>
                <p className="mt-1 text-brand-figure tabular-nums text-brand-ink">
                  {countdown.days > 0 && `${e('days', { count: countdown.days })} `}
                  {String(countdown.hours).padStart(2, '0')}:
                  {String(countdown.minutes).padStart(2, '0')}:
                  {String(countdown.seconds).padStart(2, '0')}
                </p>
              </div>
            )}
          </div>

          <dl className="mt-4 space-y-1.5 text-brand-ui">
            {current.holderName && <Row label={b('attendee')} value={current.holderName} />}
            {seat && <Row label={b('seat')} value={seat} />}
            <Row label={group.isMovie ? b('ticket') : e('type')} value={current.ticketType} />
            {place && <Row label={group.isMovie ? e('cinema') : e('venue')} value={place} />}
            <Row
              label={e('when')}
              value={`${dateTime(current.startsAt, undefined, current.timezone ?? undefined)}${current.timezone ? ` (${zoneAbbrev(current.startsAt, current.timezone)})` : ''}`}
            />
          </dl>

          <div className="mt-4 flex items-center justify-center gap-2 landscape:justify-start">
            <BrandStatusPill status={TICKET_TONE[current.status] ?? 'neutral'}>
              {statusLabel('ticket', current.status)}
            </BrandStatusPill>
            {wake.engaged ? (
              <span className="inline-flex items-center gap-1 text-brand-meta text-brand-ink-3">
                <Lock className="h-3 w-3" aria-hidden /> {e('screenOn')}
              </span>
            ) : (
              !wake.supported && (
                <span className="text-brand-meta text-brand-ink-3">{e('keepScreenOn')}</span>
              )
            )}
          </div>
        </div>
      </div>

      {/* Bottom nav: dots + prev/next */}
      {tickets.length > 1 && (
        <footer className="border-t border-brand-line p-3">
          <div className="mb-2 flex justify-center gap-1.5" aria-hidden>
            {tickets.map((t, i) => (
              <span
                key={t.id}
                className={`h-2 rounded-full transition-all ${
                  i === index ? 'w-5 bg-brand-action' : 'w-2 bg-brand-line-strong'
                } ${t.status === 'CHECKED_IN' ? 'opacity-40' : ''}`}
              />
            ))}
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => onNavigate(index - 1)}
              disabled={index === 0}
              aria-label={b('previousTicket')}
              className={`${brandButtonClasses('quiet', 'lg')} disabled:opacity-40`}
            >
              <ChevronLeft className="h-5 w-5" aria-hidden /> {b('prev')}
            </button>
            <span className="text-brand-meta tabular-nums text-brand-ink-2">
              {index + 1} / {tickets.length}
            </span>
            <button
              type="button"
              onClick={() => onNavigate(index + 1)}
              disabled={index === tickets.length - 1}
              aria-label={b('nextTicket')}
              className={`${brandButtonClasses('quiet', 'lg')} disabled:opacity-40`}
            >
              {b('next')} <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 landscape:gap-8">
      <dt className="text-brand-eyebrow uppercase text-brand-ink-3">{label}</dt>
      <dd className="min-w-0 truncate font-medium text-brand-ink">{value}</dd>
    </div>
  );
}
