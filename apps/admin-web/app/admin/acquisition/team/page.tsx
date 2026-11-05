'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Download } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  errorMessage,
  useToast,
  type CrmTeam,
} from '@eticketsgo/web-kit';
import { CRM_ACTIVITY_TYPES } from '@eticketsgo/shared-types';
import { CrmGate, RatioText, useCrmMe } from '../../../../components/crm/crm-ui';
import { LOGGED_NOT_SENT, activityLabel, countryName } from '../../../../lib/crm';

/**
 * Team performance and team membership, for acquisition managers.
 *
 * Membership is scope, not power: adding somebody here lets them see this team's leads, and only
 * people who already hold the Acquisition agent duty (granted on Staff & duties) can be added.
 * Nobody can change their own membership, and only a super admin appoints a manager.
 */
export default function TeamPage() {
  return (
    <CrmGate manager>
      <Team />
    </CrmGate>
  );
}

function Team() {
  const { me } = useCrmMe();
  const toast = useToast();
  const perf = useQuery({
    queryKey: ['crm', 'reports', 'by-employee'],
    queryFn: () => api.admin.crm.reports.byEmployee(),
  });
  const teams = useQuery({ queryKey: ['crm', 'teams'], queryFn: () => api.admin.crm.teams() });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team Performance"
        description="What each person on your teams has, and has logged, in the last 30 days."
        action={
          <Button
            variant="outline"
            icon={Download}
            onClick={() =>
              api.admin.crm.reports
                .downloadCsv('by-employee')
                .catch((e) => toast.push(errorMessage(e), 'error'))
            }
          >
            Export CSV
          </Button>
        }
      />
      <Card title="By person">
        <p className="mb-3 text-caption text-text-muted">{LOGGED_NOT_SENT}</p>
        {perf.isError ? (
          <ErrorState
            message="We could not load team performance."
            onRetry={() => perf.refetch()}
          />
        ) : !perf.data ? (
          <Skeleton className="h-32" />
        ) : perf.data.rows.length === 0 ? (
          <EmptyState compact title="No leads or activity on your teams yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Performance by person</caption>
              <thead className="text-caption text-text-secondary">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">Person</th>
                  <th className="py-2 pr-3">Leads assigned</th>
                  <th className="py-2 pr-3">Reached interested</th>
                  <th className="py-2 pr-3">Activated (approved)</th>
                  <th className="py-2 pr-3">Activities logged</th>
                  <th className="py-2 pr-3">Stage moves</th>
                  <th className="py-2">Overdue follow-ups</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {perf.data.rows.map((r) => (
                  <tr key={r.userId ?? 'none'}>
                    <td className="py-2 pr-3 font-medium text-text-primary">{r.name}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.leads?.total ?? 0}</td>
                    <td className="py-2 pr-3">
                      {r.leads ? <RatioText value={r.leads.interested} /> : '-'}
                    </td>
                    <td className="py-2 pr-3">
                      {r.leads ? <RatioText value={r.leads.activated} /> : '-'}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="tabular-nums">{r.activitiesLogged}</span>
                      <span className="block text-caption text-text-muted">
                        {CRM_ACTIVITY_TYPES.filter((t) => r.activitiesByType[t] > 0)
                          .map((t) => `${r.activitiesByType[t]} ${activityLabel(t).toLowerCase()}`)
                          .join(', ')}
                      </span>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.stageMoves}</td>
                    <td
                      className={`py-2 tabular-nums ${r.overdueFollowUps > 0 ? 'font-medium text-status-error' : ''}`}
                    >
                      {r.overdueFollowUps}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {teams.isError ? (
        <ErrorState message="We could not load your teams." onRetry={() => teams.refetch()} />
      ) : !teams.data ? (
        <Skeleton className="h-32" />
      ) : (
        teams.data
          .filter((t) => t.manages)
          .map((t) => (
            <TeamMembers key={t.id} team={t} isSuperAdmin={!!me?.isSuperAdmin} meId={me?.userId} />
          ))
      )}
    </div>
  );
}

function TeamMembers({
  team,
  isSuperAdmin,
  meId,
}: {
  team: CrmTeam;
  isSuperAdmin: boolean;
  meId?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<'AGENT' | 'MANAGER'>('AGENT');
  const candidates = useQuery({
    queryKey: ['crm', 'candidates', team.id],
    queryFn: () => api.admin.crm.candidates(team.id),
  });
  const done = (msg: string) => {
    qc.invalidateQueries({ queryKey: ['crm'] });
    toast.push(msg, 'success');
  };
  const add = useMutation({
    mutationFn: () => api.admin.crm.setMember(team.id, pick, role),
    onSuccess: () => {
      setPick('');
      done('Added to the team.');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.admin.crm.removeMember(team.id, userId),
    onSuccess: (r) =>
      done(
        r.stillAssigned > 0
          ? `Removed. ${r.stillAssigned} leads are still assigned to them: reassign them from Prospects.`
          : 'Removed from the team.',
      ),
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });
  return (
    <Card title={`${team.name} team (${countryName(team.country)})`}>
      <ul className="divide-y divide-border">
        {team.members.map((m) => (
          <li
            key={m.userId}
            className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
          >
            <span className="min-w-0">
              <span className="font-medium text-text-primary">{m.fullName}</span>{' '}
              <span className="text-caption text-text-muted">{m.email}</span>{' '}
              <Badge tone={m.role === 'MANAGER' ? 'info' : 'neutral'}>
                {m.role === 'MANAGER' ? 'Manager' : 'Agent'}
              </Badge>
              {m.holdsAgent === false && (
                <Badge tone="warning">No Acquisition agent duty: sees nothing</Badge>
              )}
            </span>
            {m.userId !== meId && (m.role === 'AGENT' || isSuperAdmin) && (
              <Button
                size="sm"
                variant="ghost"
                loading={remove.isPending}
                onClick={() => remove.mutate(m.userId)}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_160px_auto] sm:items-end">
        <Select label="Add somebody" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">
            {candidates.data?.length
              ? 'Choose a person'
              : 'Nobody with the Acquisition agent duty is left to add'}
          </option>
          {candidates.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.fullName} ({c.email})
            </option>
          ))}
        </Select>
        <Select
          label="As"
          value={role}
          onChange={(e) => setRole(e.target.value as 'AGENT' | 'MANAGER')}
          disabled={!isSuperAdmin}
          hint={isSuperAdmin ? undefined : 'Only a super admin appoints a manager.'}
        >
          <option value="AGENT">Agent</option>
          <option value="MANAGER">Manager</option>
        </Select>
        <Button disabled={!pick} loading={add.isPending} onClick={() => add.mutate()}>
          Add
        </Button>
      </div>
      <p className="mt-2 text-caption text-text-muted">
        To give somebody the Acquisition agent duty, a super admin uses Staff and duties. No
        invitation is sent from here.
      </p>
    </Card>
  );
}
