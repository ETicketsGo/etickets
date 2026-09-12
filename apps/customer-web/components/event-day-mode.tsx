'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Lock, Sun, WifiOff, X } from 'lucide-react';
import {
  eventTiming,
  useCountdown,
  useWakeLock,
  type BookingGroup,
  type WalletTicket,
} from '@eticketsgo/web-kit';
import { useFormat } from '@/lib/format';
import { StatusBadge } from '@/components/ui';
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

const BRIGHTNESS_KEY = 'etg_brightness_tip_dismissed';
const SWIPE = 48;

/**
 * Full-screen, boarding-pass style Event Day Mode. Reuses the same tickets/QRs as
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
  const { dateTime } = useFormat();
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
    ? [group.cinemaName, group.screenName].filter(Boolean).join(' · ')
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
      className="fixed inset-0 z-[60] flex flex-col bg-background-canvas focus:outline-none"
      style={{ touchAction: 'pan-y' }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Top bar */}
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[0.9375rem] font-semibold text-text-primary">{group.title}</p>
          <p className="font-mono text-caption text-text-muted">{group.bookingRef}</p>
        </div>
        <button
          onClick={onExit}
          aria-label={e('exit')}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      {/* Status strip: offline + wake-lock + brightness tip */}
      <div className="space-y-px">
        {!online && (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col items-center gap-0.5 bg-tint-warning px-4 py-1.5 text-center text-caption font-medium text-status-warning"
          >
            <span className="flex items-center gap-2">
              <WifiOff className="h-3.5 w-3.5" />{' '}
              {e('offlineVerified', {
                when: syncedAt ? dateTime(new Date(syncedAt)) : e('offlineEarlier'),
              })}
            </span>
            <span className="font-normal text-status-warning/80">{e('offlineNote')}</span>
          </div>
        )}
        {showBrightnessTip && (
          <div className="flex items-center justify-between gap-3 bg-background-subtle px-4 py-2 text-caption text-text-secondary">
            <span className="flex items-center gap-2">
              <Sun className="h-4 w-4 shrink-0 text-status-warning" />
              {e('brightnessTip')}
            </span>
            <button
              onClick={dismissBrightnessTip}
              className="shrink-0 rounded-md px-2 py-1 font-semibold text-action-primary hover:bg-background-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
            className="rounded-3xl bg-white p-3 shadow-md"
            style={{ width: 'min(78vw, 58vh)', height: 'min(78vw, 58vh)' }}
          />
          <p className="mt-3 font-mono text-[0.9375rem] text-text-secondary">{current.serial}</p>
        </div>

        {/* Details */}
        <div className="w-full max-w-sm text-center landscape:text-left">
          <p className="text-caption font-medium uppercase tracking-wide text-text-muted">
            {b('ticketOf', { index: index + 1, total: tickets.length })}
          </p>

          {/* Countdown */}
          <div className="mt-2">
            {timing.phase === 'ended' ? (
              <p className="text-title font-semibold text-text-muted">{e('ended')}</p>
            ) : timing.phase === 'live' ? (
              <p className="text-title font-semibold text-status-success">{e('live')}</p>
            ) : (
              <div>
                <p className="text-caption uppercase tracking-wide text-text-muted">
                  {e(`phase.${timing.phase}`)}
                </p>
                <p className="mt-0.5 text-h3 font-bold tabular-nums text-text-primary">
                  {countdown.days > 0 && `${e('days', { count: countdown.days })} `}
                  {String(countdown.hours).padStart(2, '0')}:
                  {String(countdown.minutes).padStart(2, '0')}:
                  {String(countdown.seconds).padStart(2, '0')}
                </p>
              </div>
            )}
          </div>

          <dl className="mt-4 space-y-1.5 text-[0.9375rem]">
            {current.holderName && <Row label={b('attendee')} value={current.holderName} />}
            {seat && <Row label={b('seat')} value={seat} />}
            <Row label={group.isMovie ? b('ticket') : e('type')} value={current.ticketType} />
            {place && <Row label={group.isMovie ? e('cinema') : e('venue')} value={place} />}
            <Row label={e('when')} value={dateTime(current.startsAt)} />
          </dl>

          <div className="mt-4 flex items-center justify-center gap-2 landscape:justify-start">
            <StatusBadge status={current.status} label={statusLabel('ticket', current.status)} />
            {wake.engaged ? (
              <span className="inline-flex items-center gap-1 text-caption text-text-muted">
                <Lock className="h-3 w-3" /> {e('screenOn')}
              </span>
            ) : (
              !wake.supported && (
                <span className="text-caption text-text-muted">{e('keepScreenOn')}</span>
              )
            )}
          </div>
        </div>
      </div>

      {/* Bottom nav: dots + prev/next */}
      {tickets.length > 1 && (
        <footer className="border-t border-border p-3">
          <div className="mb-2 flex justify-center gap-1.5" aria-hidden>
            {tickets.map((t, i) => (
              <span
                key={t.id}
                className={`h-2 rounded-full transition-all ${
                  i === index ? 'w-5 bg-action-primary' : 'w-2 bg-border-strong'
                } ${t.status === 'CHECKED_IN' ? 'opacity-40' : ''}`}
              />
            ))}
          </div>
          <div className="flex items-center justify-between">
            <button
              onClick={() => onNavigate(index - 1)}
              disabled={index === 0}
              aria-label={b('previousTicket')}
              className="flex h-12 items-center gap-1 rounded-md px-5 font-medium text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ChevronLeft className="h-5 w-5" /> {b('prev')}
            </button>
            <span className="text-caption text-text-muted">
              {index + 1} / {tickets.length}
            </span>
            <button
              onClick={() => onNavigate(index + 1)}
              disabled={index === tickets.length - 1}
              aria-label={b('nextTicket')}
              className="flex h-12 items-center gap-1 rounded-md px-5 font-medium text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {b('next')} <ChevronRight className="h-5 w-5" />
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
      <dt className="text-caption uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="min-w-0 truncate font-medium text-text-primary">{value}</dd>
    </div>
  );
}
