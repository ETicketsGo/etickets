'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Banknote,
  Building2,
  CalendarCheck2,
  KeyRound,
  RotateCcw,
  Settings2,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  dateTime,
  EmptyState,
  ErrorState,
  IconTile,
  SectionCard,
  SectionLink,
  Skeleton,
  type TileTone,
} from '@eticketsgo/web-kit';
import { accountContactText } from '@/components/account-contact';

/** What an audit action is about, by its prefix, as the timeline's icon and tile. */
const KINDS: { prefix: string; icon: LucideIcon; tone: TileTone }[] = [
  { prefix: 'AUTH', icon: KeyRound, tone: 'blue' },
  { prefix: 'ORGANIZATION', icon: Building2, tone: 'purple' },
  { prefix: 'ORGANIZER', icon: Building2, tone: 'purple' },
  { prefix: 'EVENT', icon: CalendarCheck2, tone: 'teal' },
  { prefix: 'SESSION', icon: CalendarCheck2, tone: 'teal' },
  { prefix: 'BOOKING', icon: Ticket, tone: 'blue' },
  { prefix: 'REFUND', icon: RotateCcw, tone: 'amber' },
  { prefix: 'PAYOUT', icon: Banknote, tone: 'teal' },
  { prefix: 'SETTLEMENT', icon: Banknote, tone: 'teal' },
  { prefix: 'ADMIN', icon: Settings2, tone: 'rose' },
];

function kindOf(action: string): { icon: LucideIcon; tone: TileTone } {
  return KINDS.find((k) => action.startsWith(k.prefix)) ?? { icon: Activity, tone: 'neutral' };
}

/** "AUTH_LOGIN" -> "Auth login": a sentence, not a constant shouted at the reader. */
function actionText(action: string): string {
  const words = action.toLowerCase().replaceAll('_', ' ').replaceAll('.', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The last privileged actions, from `GET /admin/audit` - the reference's activity timeline,
 * with real entries only. BOOKING_READ, as the audit log itself; the parent decides.
 */
export function RecentActivity() {
  const audit = useQuery({
    queryKey: ['admin', 'audit', 1],
    queryFn: () => api.admin.audit({ page: 1, pageSize: 6 }),
  });
  return (
    <SectionCard
      title="Recent activity"
      action={
        <SectionLink href="/admin/audit" srLabel="in the audit log">
          View all
        </SectionLink>
      }
    >
      {audit.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : audit.isError ? (
        <ErrorState message="We couldn't load recent activity." onRetry={() => audit.refetch()} />
      ) : audit.data && audit.data.data.length > 0 ? (
        <div className="relative">
          {/* The thread joining the entries; decoration only. */}
          <span aria-hidden className="absolute bottom-3 left-4 top-3 w-px bg-border" />
          <ol className="relative space-y-4">
            {audit.data.data.map((a) => {
              const kind = kindOf(a.action);
              const who = a.actor ? (accountContactText(a.actor.email) ?? 'an account') : 'System';
              return (
                <li key={a.id} className="relative flex gap-3">
                  <IconTile
                    icon={kind.icon}
                    tone={kind.tone}
                    size="sm"
                    className="ring-4 ring-background-surface"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-ui font-semibold text-text-primary">
                      {actionText(a.action)}
                    </p>
                    <p className="break-words text-caption text-text-secondary">
                      {who}
                      {a.organizationName ? ` - ${a.organizationName}` : ''}
                    </p>
                    <p className="text-caption tabular-nums text-text-muted">
                      {dateTime(a.createdAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <EmptyState
          compact
          title="No recent activity"
          hint="Privileged actions will appear here."
        />
      )}
    </SectionCard>
  );
}
