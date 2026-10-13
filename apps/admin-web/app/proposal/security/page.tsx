'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, useAuthUser } from '@eticketsgo/web-kit';
import {
  AsOf,
  LINK,
  PageHead,
  Panel,
  Pending,
  ProposalNote,
  State,
  Td,
  Th,
  Unread,
} from '@/components/proposal/desk';
import { lastSevenDays } from '@/lib/attention';
import {
  ACCESS_ACTIONS,
  auditActionWords,
  capabilityWords,
  describeGrant,
  type Grant,
} from '@/lib/proposal-model';

/**
 * PROPOSAL - staff and security on one page (docs/design/ADMIN-PROPOSAL.md).
 *
 * Today the question "is our back office safe" is answered by three pages that do not link to
 * each other: Staff & duties (under Platform configuration), Account security (under My
 * account) and the Audit log (filtered by hand). This page puts the answer in one place:
 * the attack and change signals for the last seven days, who holds what said as the preset it
 * is, and the latest access events. Where the API cannot answer (another person's MFA, open
 * sessions) the page says so instead of showing a blank or a guess.
 */

const SIGNALS: { action: (typeof ACCESS_ACTIONS)[number]; alarm: boolean }[] = [
  { action: 'AUTH_TOKEN_REUSE_DETECTED', alarm: true },
  { action: 'AUTH_LOGIN_FAILED', alarm: false },
  { action: 'ADMIN_PERMISSIONS_CHANGED', alarm: false },
  { action: 'MFA_DEVICE_REPLACED', alarm: false },
];

function grantWords(g: Grant): { text: string; tone: 'live' | 'neutral' | 'info' | 'caution' } {
  switch (g.kind) {
    case 'super':
      return { text: 'Super admin: everything', tone: 'caution' };
    case 'none':
      return { text: 'No duties yet', tone: 'neutral' };
    case 'preset':
      return { text: g.label, tone: 'info' };
    case 'preset-plus':
      return { text: `${g.label} + ${g.extra.length}`, tone: 'info' };
    case 'custom':
      return { text: `Custom: ${g.count} duties`, tone: 'neutral' };
  }
}

export default function ProposalSecurity() {
  const { user } = useAuthUser();
  const caps = useMemo(() => new Set(user?.adminPermissions ?? []), [user?.adminPermissions]);
  const mayManage = caps.has('ADMIN_MANAGE');
  const mayAudit = caps.has('BOOKING_READ');
  const window7 = useMemo(() => lastSevenDays(new Date()), []);

  const mfa = useQuery({ queryKey: ['auth', 'mfa-status'], queryFn: () => api.auth.mfaStatus() });
  const staff = useQuery({
    queryKey: ['admin', 'staff'],
    queryFn: () => api.admin.staff.list(),
    enabled: mayManage,
  });
  const catalogue = useQuery({
    queryKey: ['admin', 'staff', 'catalogue'],
    queryFn: () => api.admin.staff.catalogue(),
    enabled: mayManage,
  });
  const signals = useQueries({
    queries: SIGNALS.map((s) => ({
      queryKey: ['proposal', 'audit-count', s.action, window7.from],
      queryFn: () => api.admin.auditSummary({ action: s.action, ...window7 }),
      enabled: mayAudit,
      retry: false,
    })),
  });
  const events = useQueries({
    queries: ACCESS_ACTIONS.map((action) => ({
      queryKey: ['proposal', 'audit-latest', action],
      queryFn: () => api.admin.audit({ page: 1, pageSize: 8, action }),
      enabled: mayAudit,
      retry: false,
    })),
  });
  const latest = events
    .flatMap((e) => e.data?.data ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 12);

  const presets = catalogue.data?.presets ?? [];
  const members = staff.data ?? [];
  const byPreset = new Map<string, number>();
  for (const m of members) {
    const w = grantWords(describeGrant(m, presets)).text.replace(/ \+ \d+$/, ' plus extras');
    byPreset.set(w, (byPreset.get(w) ?? 0) + 1);
  }
  const asOf = Math.max(staff.dataUpdatedAt, ...signals.map((s) => s.dataUpdatedAt), 0);

  return (
    <>
      <ProposalNote />
      <PageHead
        eyebrow="Access"
        title="Staff and security"
        description="Who can do what in the back office, how they sign in, and what changed. Granting and removing duties stays on the staff page, behind a fresh authenticator code."
        meta={
          <AsOf
            at={asOf || null}
            onRefresh={() => {
              void staff.refetch();
              signals.forEach((s) => void s.refetch());
              events.forEach((e) => void e.refetch());
              void mfa.refetch();
            }}
          />
        }
        action={
          mayManage ? (
            <Link href="/admin/staff" className={`${LINK} text-brand-ui`}>
              Change duties
            </Link>
          ) : undefined
        }
      />

      {mayAudit && (
        <Panel
          id="signals"
          title="Signals"
          meta={`Audit log entries from ${window7.from} to ${window7.to} (UTC days), all accounts.`}
        >
          <ul className="grid gap-px overflow-hidden rounded-brand-card border border-brand-line bg-brand-line sm:grid-cols-2 lg:grid-cols-4">
            {SIGNALS.map((s, i) => {
              const q = signals[i];
              const n = q?.data?.total;
              return (
                <li key={s.action} className="bg-brand-surface p-4">
                  <p className="text-brand-eyebrow uppercase text-brand-ink-3">
                    {auditActionWords(s.action)}
                  </p>
                  <p
                    className={`mt-2 text-brand-figure tabular-nums ${s.alarm && n ? 'text-brand-critical' : 'text-brand-ink'}`}
                  >
                    {q?.isError ? '?' : n === undefined ? '...' : n.toLocaleString('en-IN')}
                  </p>
                  <p className="mt-1 text-brand-meta text-brand-ink-2">
                    {q?.isError
                      ? 'Could not be counted'
                      : s.alarm
                        ? n
                          ? 'Look at each one: it can mean a copied token, or two tabs refreshing at once'
                          : 'None. This should stay at zero.'
                        : 'Last 7 days'}
                  </p>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {mayManage && (
        <Panel
          id="staff"
          title="Back-office staff"
          meta={
            staff.data
              ? `${members.length} accounts with the admin role, now. Duties shown as the preset they match.`
              : 'Accounts with the admin role.'
          }
          flush
        >
          {staff.isError ? (
            <div className="px-4 pb-4 sm:px-6">
              <Unread what="the staff list" onRetry={() => staff.refetch()} />
            </div>
          ) : staff.isLoading || catalogue.isLoading ? (
            <div className="px-4 pb-4 sm:px-6">
              <Pending className="h-48" />
            </div>
          ) : (
            <>
              {byPreset.size > 0 && (
                <ul
                  className="flex flex-wrap gap-x-6 gap-y-1 px-4 pb-3 text-brand-meta text-brand-ink-2 sm:px-6"
                  aria-label="Staff by preset"
                >
                  {[...byPreset.entries()].map(([label, n]) => (
                    <li key={label}>
                      {label}:{' '}
                      <span className="font-semibold tabular-nums text-brand-ink">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div
                className="overflow-x-auto border-t border-brand-line"
                tabIndex={0}
                role="region"
                aria-label="Staff"
              >
                <table className="w-full">
                  <caption className="sr-only">
                    Back-office staff, their duties and their second sign-in step
                  </caption>
                  <thead className="border-b border-brand-line">
                    <tr>
                      <Th>Person</Th>
                      <Th>Duties</Th>
                      <Th className="hidden sm:table-cell">Second step</Th>
                      <Th className="hidden sm:table-cell">Account</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-line">
                    {members.map((m) => {
                      const g = describeGrant(m, presets);
                      const w = grantWords(g);
                      const self = m.id === user?.id;
                      return (
                        <tr key={m.id}>
                          <Td>
                            <span className="block font-semibold">
                              {m.fullName}
                              {self && <span className="font-normal text-brand-ink-3"> (you)</span>}
                            </span>
                            <span className="block break-all text-brand-meta text-brand-ink-3">
                              {m.email}
                            </span>
                            <span className="block text-brand-meta text-brand-ink-2 sm:hidden">
                              {m.status === 'ACTIVE' ? 'Active' : capabilityWords(m.status)}, second
                              step{' '}
                              {self && mfa.data
                                ? mfa.data.enrolled
                                  ? 'on'
                                  : 'not set up'
                                : 'not reported'}
                            </span>
                          </Td>
                          <Td>
                            <State tone={w.tone}>{w.text}</State>
                            {g.kind === 'preset-plus' && (
                              <span className="mt-1 block text-brand-meta text-brand-ink-2">
                                Extra: {g.extra.map(capabilityWords).join(', ')}
                              </span>
                            )}
                          </Td>
                          <Td className="hidden sm:table-cell">
                            {self && mfa.data ? (
                              mfa.data.enrolled ? (
                                <State tone="positive">Authenticator on</State>
                              ) : (
                                <State tone="critical">Not set up</State>
                              )
                            ) : (
                              <span className="text-brand-meta text-brand-ink-3">Not reported</span>
                            )}
                          </Td>
                          <Td className="hidden sm:table-cell">
                            <State tone={m.status === 'ACTIVE' ? 'positive' : 'neutral'}>
                              {m.status === 'ACTIVE' ? 'Active' : capabilityWords(m.status)}
                            </State>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-brand-line px-4 py-3 text-brand-meta text-brand-ink-2 sm:px-6">
                The staff list does not say whether another person has an authenticator, so their
                second step shows &quot;Not reported&quot; rather than a guess. The proposal asks
                for that field.
              </p>
            </>
          )}
        </Panel>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {mayAudit && (
          <Panel
            id="events"
            title="Latest access events"
            meta="Sign-in failures, duty changes and authenticator changes, newest first. Times in your time zone."
            action={
              <Link href="/admin/audit" className={`${LINK} text-brand-meta`}>
                Audit log
              </Link>
            }
            flush
          >
            {events.some((e) => e.isLoading) ? (
              <div className="px-4 pb-4 sm:px-6">
                <Pending className="h-48" />
              </div>
            ) : latest.length === 0 ? (
              <p className="px-4 pb-4 text-brand-ui text-brand-ink-2 sm:px-6">
                No access events recorded.
              </p>
            ) : (
              <ul className="divide-y divide-brand-line border-t border-brand-line">
                {latest.map((e) => (
                  <li
                    key={e.id}
                    className="grid gap-x-4 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_11rem] sm:px-6"
                  >
                    <span className="min-w-0">
                      <span className="block text-brand-ui font-semibold text-brand-ink">
                        {auditActionWords(e.action)}
                      </span>
                      <span className="block break-all text-brand-meta text-brand-ink-2">
                        {e.actor
                          ? `${e.actor.fullName} (${e.actor.email})`
                          : 'No account (system or unknown)'}
                      </span>
                    </span>
                    <span className="text-brand-meta tabular-nums text-brand-ink-3 sm:text-right">
                      {new Date(e.createdAt).toLocaleString('en-GB', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        <div className="space-y-8">
          <Panel id="mine" title="Your sign-in">
            {mfa.isLoading ? (
              <Pending className="h-16" />
            ) : mfa.isError ? (
              <Unread what="your sign-in status" onRetry={() => mfa.refetch()} />
            ) : mfa.data ? (
              <div className="space-y-2 text-brand-ui">
                {mfa.data.enrolled ? (
                  <State tone="positive">Authenticator on</State>
                ) : (
                  <State tone="critical">Authenticator not set up</State>
                )}
                <p className="text-brand-ink-2">
                  <span className="font-semibold tabular-nums text-brand-ink">
                    {mfa.data.recoveryCodesRemaining}
                  </span>{' '}
                  recovery codes left.
                </p>
                <Link href="/admin/security" className={`${LINK} text-brand-meta`}>
                  Manage your sign-in
                </Link>
              </div>
            ) : null}
          </Panel>
          <Panel id="sessions" title="Open sessions">
            <p className="text-brand-meta text-brand-ink-2">
              Not available yet: the API does not list signed-in sessions or let an admin end one.
              Today a session ends when its token expires or the person signs out. The proposal
              lists this as a gap for the owner.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
