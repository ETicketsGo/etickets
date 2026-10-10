'use client';

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { tileClasses, type TileTone } from '@eticketsgo/web-kit';

/**
 * The Overview's stat card: web-kit's `StatCard` from a tablet up, and a compact version that
 * fits two across on a 320px phone.
 *
 * ── WHY NOT `StatCard` ITSELF ──────────────────────────────────────────────────────
 * `StatCard` puts a 48px tile beside the number at every width. Two across on a phone that
 * leaves about 70px for "₹17,147.82", so four cards had to stack into a 450px column. Here the
 * tile moves above the label on a phone and the number scales with the screen (never below
 * 17px, never truncated: a long amount wraps rather than losing digits). From `sm` up it is the
 * same tile, sizes and tokens as `StatCard`, so the console reads as one system.
 */
export function GlanceCard({
  label,
  value,
  hint,
  icon: Icon,
  tile,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tile: TileTone;
  href?: string;
}) {
  const body = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
      <span
        aria-hidden
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md sm:h-12 sm:w-12 sm:rounded-lg [&>svg]:h-4 [&>svg]:w-4 sm:[&>svg]:h-6 sm:[&>svg]:w-6 ${tileClasses(tile)}`}
      >
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-caption font-medium text-text-secondary sm:text-ui">{label}</p>
        <p className="mt-0.5 font-display text-[clamp(1.0625rem,5vw,1.375rem)] font-bold leading-tight tracking-tight tabular-nums text-text-primary [overflow-wrap:anywhere] sm:mt-1 sm:text-[1.625rem]">
          {value}
        </p>
        {hint && (
          <p className="mt-0.5 text-micro text-text-muted sm:mt-1 sm:text-caption">{hint}</p>
        )}
      </div>
    </div>
  );
  const frame =
    'block h-full min-w-0 rounded-lg border border-border bg-background-surface p-3.5 shadow-xs sm:p-5';
  return href ? (
    <Link
      href={href}
      className={`${frame} transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
    >
      {body}
    </Link>
  ) : (
    <div className={frame}>{body}</div>
  );
}
