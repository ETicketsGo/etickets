'use client';

import type { ReactNode } from 'react';
import { Badge, Textarea, dateOnly } from '@eticketsgo/web-kit';
import { reasonProblem, subscriptionStatusTone, subscriptionStatusWords } from '../../lib/billing';

/** A subscription state as a coloured badge, in words. */
export function SubscriptionStatusBadge({ status }: { status: string | null | undefined }) {
  return <Badge tone={subscriptionStatusTone(status)}>{subscriptionStatusWords(status)}</Badge>;
}

/** A figure with its name, as the acquisition overview shows them. */
export function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background-surface p-4 shadow-sm">
      <p className="text-caption font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-caption text-text-muted">{hint}</p>}
    </div>
  );
}

/** A day, or "-" when there is none (the shared formatter prints a non-ASCII dash). */
export function day(value: string | null | undefined): string {
  return value ? dateOnly(value) : '-';
}

/**
 * The reason box every billing write asks for. The error shows only after the operator has
 * tried to submit, so an empty box does not open red.
 */
export function ReasonField({
  value,
  onChange,
  tried,
  label = 'Reason',
}: {
  value: string;
  onChange: (value: string) => void;
  tried: boolean;
  label?: string;
}) {
  return (
    <Textarea
      label={label}
      rows={2}
      value={value}
      maxLength={500}
      hint="Saved in the audit log. At least 3 characters."
      error={tried ? reasonProblem(value) : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A small titled list inside a card, with its own empty line. */
export function SectionNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-secondary">{children}</p>;
}
