'use client';

import { useQuery } from '@tanstack/react-query';
import { Clapperboard } from 'lucide-react';
import {
  api,
  ErrorState,
  IconTile,
  SectionCard,
  SectionLink,
  Skeleton,
  StatusPill,
  type PillTone,
} from '@eticketsgo/web-kit';

/** The four states a policy can be in, in the order an operator cares about them. */
const STATES: { status: string; label: string; tone: PillTone }[] = [
  { status: 'ACTIVE', label: 'Active', tone: 'success' },
  { status: 'DRAFT', label: 'Draft', tone: 'warning' },
  { status: 'SUPERSEDED', label: 'Superseded', tone: 'neutral' },
  { status: 'DISABLED', label: 'Disabled', tone: 'neutral' },
];

/**
 * Regulated cinema pricing at a glance: how many policies are in force and how many drafts sit
 * unactivated, counted from `GET /admin/cinema-pricing-policies` - the list the page opens on.
 *
 * Read only. Activating or superseding a policy changes what a cinema may charge, so it is done
 * on the policy page with its own confirmation, never from a dashboard. Shown only with
 * PLATFORM_CONFIG_READ; the parent decides.
 */
export function CinemaPricingSummary() {
  const policies = useQuery({
    queryKey: ['admin', 'cinema-pricing-policies'],
    queryFn: () => api.admin.cinemaPricingPolicies(),
  });
  const rows = policies.data ?? [];
  const count = (status: string) => rows.filter((p) => p.status === status).length;
  const regions = new Set(rows.filter((p) => p.status === 'ACTIVE').map((p) => p.region)).size;

  return (
    <SectionCard
      title="Cinema pricing"
      action={
        <SectionLink href="/admin/cinema-pricing" srLabel="cinema pricing policies">
          Policies
        </SectionLink>
      }
    >
      {policies.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : policies.isError ? (
        <ErrorState
          message="We could not load the pricing policies."
          onRetry={() => policies.refetch()}
        />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-secondary">No cinema pricing policy is recorded yet.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <IconTile icon={Clapperboard} tone="purple" size="md" />
            <p className="min-w-0 text-ui text-text-secondary">
              <span className="font-display text-[1.375rem] font-bold tabular-nums text-text-primary">
                {count('ACTIVE')}
              </span>{' '}
              {count('ACTIVE') === 1 ? 'policy' : 'policies'} in force
              {regions > 0 ? `, in ${regions} ${regions === 1 ? 'region' : 'regions'}` : ''}
            </p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {STATES.map((s) => (
              <li key={s.status}>
                <StatusPill tone={count(s.status) > 0 ? s.tone : 'neutral'} size="sm">
                  {count(s.status)} {s.label.toLowerCase()}
                </StatusPill>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
