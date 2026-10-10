'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info } from 'lucide-react';
import { api, SectionCard, StatusPill } from '@eticketsgo/web-kit';
import { currencyNotices } from '@/lib/finance-view';

/**
 * What this page cannot tell the organizer, and why.
 *
 * ── WHY THIS IS ITS OWN COMPONENT ──────────────────────────────────────────────────
 * These notices used to render inside the provider-settled section, which was wrong twice. A
 * warning describes a CURRENCY, not a settlement route - `DEDUCTION_DETAIL_UNAVAILABLE` comes
 * from old PAYOUTS - so it sat under a heading about provider money and appeared to be about
 * money it had nothing to do with.
 *
 * And the provider section renders nothing at all when an organization has no provider route,
 * which is the common case, so the notice silently vanished and an admittedly incomplete
 * breakdown was presented as complete. A limitation that hides itself is exactly the failure
 * this read model exists to prevent.
 *
 * ── IT FAILS QUIETLY, ON PURPOSE ───────────────────────────────────────────────────
 * No loading skeleton and no error state. This block only ever ADDS a caveat to figures that are
 * already on screen and already true. An error banner here would tell the organizer something is
 * wrong with their money when nothing is; the provider section owns the visible failure state for
 * this request, and both share one query key so only one request is made.
 */
export function FinanceNotices({ organizationId }: { organizationId: string }) {
  const { data, isSuccess } = useQuery({
    queryKey: ['organizer', 'unified-finance', organizationId],
    queryFn: () => api.payouts.finance(organizationId),
  });

  if (!isSuccess) return null;

  const groups = currencyNotices({ kind: 'LOADED', data });
  if (groups.length === 0) return null;

  const multiCurrency = groups.length > 1;

  return (
    <SectionCard title="About these figures">
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.currency}>
            {/* Named only when there is more than one, so a single-currency page reads plainly. */}
            {multiCurrency && (
              <h3 className="mb-1 text-sm font-semibold text-text-primary">{group.currency}</h3>
            )}
            <ul className="space-y-2">
              {group.notices.map((n) => (
                <li key={n.message} className="flex flex-wrap items-start gap-2">
                  <span
                    className={
                      n.tone === 'attention'
                        ? 'mt-0.5 text-status-warning'
                        : 'mt-0.5 text-text-muted'
                    }
                  >
                    {n.tone === 'attention' ? (
                      <AlertTriangle className="h-4 w-4" aria-hidden />
                    ) : (
                      <Info className="h-4 w-4" aria-hidden />
                    )}
                  </span>
                  {/* Words as well as an icon, so the difference is never colour or shape alone. */}
                  <StatusPill tone={n.tone === 'attention' ? 'warning' : 'neutral'} size="sm">
                    {n.tone === 'attention' ? 'Needs attention' : 'Note'}
                  </StatusPill>
                  <span className="min-w-0 flex-1 text-ui text-text-secondary">{n.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
