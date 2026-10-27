'use client';

import Link from 'next/link';
import { Lock, MailX } from 'lucide-react';
import { Badge, EmptyState, type AudiencePreview, type CampaignStatus } from '@eticketsgo/web-kit';
import { STATUS_WORDS, type Gate } from '@/lib/campaigns';

/** A campaign's status as a chip: a dot and words, never colour alone. */
export function CampaignStatusChip({ status }: { status: CampaignStatus }) {
  const w = STATUS_WORDS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={w.tone}>{w.label}</Badge>;
}

/** What to show instead of the campaign pages when they are off here or not on the plan. */
export function CampaignGateNotice({ gate }: { gate: Exclude<Gate, { kind: 'ready' }> }) {
  return (
    <div data-testid={`campaign-gate-${gate.kind}`}>
      <EmptyState
        icon={gate.kind === 'plan' ? Lock : MailX}
        tone="purple"
        title={gate.title}
        hint={gate.hint}
        action={
          gate.kind === 'plan' ? (
            <Link
              href="/organizer/billing"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-action-primary px-5 text-ui font-semibold text-action-primary-foreground hover:bg-action-primary-hover"
            >
              See plans
            </Link>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Horizontal bars, drawn with plain elements. Each bar is labelled in text and the whole chart
 * has a table-like reading order, so a screen reader gets the numbers, not a picture.
 */
export function BarList({
  rows,
  label,
  emptyText = 'Nothing to show for this range.',
}: {
  rows: { key: string; label: string; value: number }[];
  label: string;
  emptyText?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0 || rows.every((r) => r.value === 0)) {
    return <p className="text-ui text-text-secondary">{emptyText}</p>;
  }
  return (
    <ul className="space-y-2" aria-label={label}>
      {rows.map((r) => (
        <li
          key={r.key}
          className="grid grid-cols-[minmax(6rem,10rem)_1fr_3rem] items-center gap-3 text-ui"
        >
          <span className="truncate text-text-secondary">{r.label}</span>
          <span className="h-3 rounded-full bg-background-subtle" aria-hidden>
            <span
              className="block h-3 rounded-full bg-action-primary"
              style={{ width: `${Math.max(2, Math.round((r.value / max) * 100))}%` }}
            />
          </span>
          <span className="text-right tabular-nums text-text-primary">
            {r.value.toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Vertical bars for a time series. A visually hidden list carries the same numbers. */
export function SeriesBars({
  points,
  label,
}: {
  points: { start: string; count: number }[];
  label: string;
}) {
  const max = Math.max(1, ...points.map((p) => p.count));
  return (
    <figure>
      <div className="flex h-32 items-end gap-0.5" aria-hidden>
        {points.map((p) => (
          <div
            key={p.start}
            className="flex-1 rounded-t bg-action-primary"
            style={{ height: `${Math.max(2, Math.round((p.count / max) * 100))}%` }}
            title={`${p.start}: ${p.count}`}
          />
        ))}
      </div>
      <figcaption className="sr-only">
        {label}: {points.map((p) => `${p.start} ${p.count}`).join(', ')}
      </figcaption>
      <div className="mt-1 flex justify-between text-caption text-text-muted" aria-hidden>
        <span>{points[0]?.start}</span>
        <span>{points[points.length - 1]?.start}</span>
      </div>
    </figure>
  );
}

/** The audience counts, as the builder and the review show them. */
export function AudienceCounts({ counts }: { counts: AudiencePreview }) {
  const rows: { label: string; value: number; hint: string }[] = [
    {
      label: 'Will get it',
      value: counts.eligible,
      hint: 'Agreed to this kind of email and can receive it.',
    },
    {
      label: 'Not agreed',
      value: counts.noConsent,
      hint: 'Have not agreed to this kind of email from you.',
    },
    {
      label: 'Unsubscribed',
      value: counts.suppressedOrganizer,
      hint: 'Asked you to stop emailing them.',
    },
    {
      label: 'Address not working',
      value: counts.suppressedGlobal,
      hint: 'The address bounced or reported spam before.',
    },
  ];
  return (
    <div data-testid="audience-counts">
      <dl className="grid gap-3 sm:grid-cols-4">
        {rows.map((r) => (
          <div key={r.label} className="rounded-lg border border-border p-3">
            <dt className="text-caption text-text-secondary">{r.label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-text-primary">
              {r.value.toLocaleString()}
            </dd>
            <dd className="mt-1 text-caption text-text-muted">{r.hint}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-ui text-text-secondary">
        {counts.matched.toLocaleString()} people match. Sending uses{' '}
        {counts.estimatedCredits.toLocaleString()}{' '}
        {counts.estimatedCredits === 1 ? 'email' : 'emails'} from your plan.{' '}
        {counts.enoughQuota
          ? `You have ${counts.quotaRemaining.toLocaleString()} left this month.`
          : `You have only ${counts.quotaRemaining.toLocaleString()} left this month.`}
      </p>
    </div>
  );
}
