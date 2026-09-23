'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Info } from 'lucide-react';
import { api, Card } from '@eticketsgo/web-kit';

/**
 * What this organizer still has to do, at the top of their own dashboard.
 *
 * ── WHY IT IS HERE AND NOT A NAG ───────────────────────────────────────────────────
 * The platform asks organizers for a lot - a legal identity, an address, a finance contact,
 * a bank account - and until now it asked for none of it anywhere they would look. They
 * found out when a settlement could not be paid, or when an admin wrote to them.
 *
 * Every item says what the gap COSTS rather than that it is required, because none of them
 * stops an organizer selling today and saying otherwise would be a lie the product tells.
 * The list is the same one the admin console reads, so the two never disagree.
 *
 * It renders nothing at all when there is nothing to do. A permanent "all good" panel is a
 * thing people learn to scroll past, and then miss the day it says something.
 */
const TONE = {
  BLOCKING: {
    icon: AlertTriangle,
    badge: 'bg-status-error/10 text-status-error',
    label: 'Blocking',
  },
  IMPORTANT: {
    icon: AlertTriangle,
    badge: 'bg-status-warning/10 text-status-warning',
    label: 'Important',
  },
  SUGGESTED: { icon: Info, badge: 'bg-tint-primary text-action-primary', label: 'Suggested' },
} as const;

export function NeedsAttention({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: ['organizer', 'readiness', orgId],
    queryFn: () => api.organizations.readiness(orgId),
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  if (items.length === 0) return null;

  // Blocking first: "your money cannot be paid" outranks "add a profile picture".
  const order = { BLOCKING: 0, IMPORTANT: 1, SUGGESTED: 2 } as const;
  const sorted = [...items].sort((a, b) => order[a.severity] - order[b.severity]);
  const blocking = items.filter((i) => i.severity === 'BLOCKING').length;

  return (
    <Card
      title="Needs your attention"
      className={blocking > 0 ? 'border-status-error/30' : undefined}
    >
      <p className="-mt-2 mb-4 text-caption text-text-secondary">
        {blocking > 0
          ? 'Something here stops the platform doing what you expect.'
          : 'None of these stops you selling. They decide what your buyers and your accountant get.'}
      </p>
      <ul className="divide-y divide-border">
        {sorted.map((item) => {
          const tone = TONE[item.severity];
          const Icon = tone.icon;
          return (
            <li key={item.key} className="py-3 first:pt-0 last:pb-0">
              <Link
                href={item.fixPath}
                className="group flex items-start gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${tone.badge.split(' ')[1]}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text-primary group-hover:text-action-primary">
                    {item.title}
                  </p>
                  <p className="text-caption text-text-muted">{item.consequence}</p>
                </div>
                <span
                  className={`hidden shrink-0 rounded-full px-2 py-0.5 text-caption font-medium sm:inline ${tone.badge}`}
                >
                  {tone.label}
                </span>
                <ArrowRight
                  className="mt-0.5 h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The tick shown on Settings once nothing is outstanding, where somebody goes to look. */
export function ReadinessComplete({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: ['organizer', 'readiness', orgId],
    queryFn: () => api.organizations.readiness(orgId),
    staleTime: 30_000,
  });
  if (!data || data.items.length > 0) return null;
  return (
    <p className="flex items-center gap-2 text-caption text-status-success">
      <CheckCircle2 className="h-4 w-4" aria-hidden />
      Everything we ask for is on file.
    </p>
  );
}
