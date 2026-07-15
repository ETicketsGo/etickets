'use client';

import Link from 'next/link';
import {
  BadgeCheck,
  Car,
  CheckCircle2,
  ChevronRight,
  Gift,
  ShoppingBag,
  Ticket as TicketIcon,
  TicketPercent,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  gradientFor,
  type GroupStatusTone,
  type WalletItem,
  type WalletItemType,
} from '@eticketsgo/web-kit';
import { dateTime } from '@/lib/format';

const TYPE_ICON: Record<WalletItemType, LucideIcon> = {
  TICKET: TicketIcon,
  MEMBERSHIP: BadgeCheck,
  PARKING: Car,
  COUPON: TicketPercent,
  MERCHANDISE: ShoppingBag,
  REWARD: Gift,
};

const TONE: Record<GroupStatusTone, { text: string; dot: string; Icon: LucideIcon }> = {
  success: { text: 'text-status-success', dot: 'bg-status-success', Icon: CheckCircle2 },
  info: { text: 'text-status-info', dot: 'bg-status-info', Icon: CheckCircle2 },
  warning: { text: 'text-status-warning', dot: 'bg-status-warning', Icon: TriangleAlert },
  error: { text: 'text-status-error', dot: 'bg-status-error', Icon: XCircle },
  neutral: { text: 'text-text-secondary', dot: 'bg-text-muted', Icon: TicketIcon },
};

/**
 * Renders ANY wallet item from its normalized shape — no per-type branching. A
 * ticket, membership, coupon or parking pass all draw from WalletItem fields.
 */
export function WalletCard({
  item,
  onPreview,
}: {
  item: WalletItem;
  onPreview?: (item: WalletItem) => void;
}) {
  const Icon = TYPE_ICON[item.icon] ?? TicketIcon;
  const tone = TONE[item.statusTone];
  const pct = item.progress ? Math.round((item.progress.done / item.progress.total) * 100) : 0;

  return (
    <article
      aria-labelledby={`wi-${item.id}`}
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm transition-shadow hover:shadow-md"
    >
      <div
        className={`relative flex h-20 items-end bg-gradient-to-br p-4 ${gradientFor(item.artworkSeed)}`}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-background-surface/90 px-2.5 py-1 text-caption font-medium text-text-secondary shadow-sm backdrop-blur">
          <Icon className="h-3.5 w-3.5" />
          {item.badge ?? item.type}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <h2
          id={`wi-${item.id}`}
          className="line-clamp-1 text-title font-semibold text-text-primary"
        >
          {item.title}
        </h2>
        {item.subtitle && (
          <p className="mt-0.5 line-clamp-1 text-[0.9375rem] text-text-secondary">
            {item.subtitle}
          </p>
        )}

        {/* Status (text + icon + dot — never colour alone) */}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={`inline-flex items-center gap-1.5 text-caption font-medium ${tone.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
            <tone.Icon className="h-3.5 w-3.5" aria-hidden />
            {item.status}
          </span>
          {item.startsAt && (
            <span className="text-caption text-text-muted">· {dateTime(item.startsAt)}</span>
          )}
          {item.expiresAt && !item.startsAt && (
            <span className="text-caption text-text-muted">
              · expires {dateTime(item.expiresAt)}
            </span>
          )}
        </div>

        {/* Progress */}
        {item.progress && (
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-caption text-text-muted">
              <span>{item.progress.label}</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-background-subtle"
              role="img"
              aria-label={item.progress.label}
            >
              <div className="h-full rounded-full bg-status-info" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
          <span className="font-mono text-caption text-text-muted">{item.reference ?? ' '}</span>
          {item.primaryAction.href ? (
            <Link
              href={item.primaryAction.href}
              className="inline-flex items-center gap-1.5 rounded-md bg-action-primary px-4 py-2 text-caption font-semibold text-action-primary-foreground shadow-sm transition-colors hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
            >
              {item.primaryAction.label}
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <button
              onClick={() => onPreview?.(item)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-caption font-semibold text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {item.primaryAction.label}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
