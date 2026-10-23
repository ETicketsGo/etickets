'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  api,
  ApiRequestError,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  dateOnly,
  errorMessage,
  recordedAt,
  useToast,
  type CrmDuplicateMatch,
  type CrmLeadDetail,
} from '@eticketsgo/web-kit';
import {
  CRM_ACTIVITY_OUTCOMES,
  CRM_ACTIVITY_TYPES,
  CRM_LEAD_SOURCES,
  CRM_PRIORITIES,
} from '@eticketsgo/shared-types';
import {
  CrmGate,
  DerivedBadge,
  DuplicateList,
  StageBadge,
} from '../../../../../components/crm/crm-ui';
import {
  LOGGED_NOT_SENT,
  activityLabel,
  countryName,
  followUpState,
  fromLocalInput,
  nextActionText,
  outcomeLabel,
  sourceLabel,
  stageLabel,
  toLocalInput,
  wholeDays,
} from '../../../../../lib/crm';

/**
 * One prospect: its details, where it is in the pipeline and how it got there, the outreach
 * logged against it, its follow-ups, and - once it is won - the organizer account it became.
 *
 * Every change sends the version of the lead this page last read. If somebody else changed the
 * lead in between, the server refuses and this page reloads it rather than overwrite them.
 */
export default function LeadPage() {
  return (
    <CrmGate>
      <Lead />
    </CrmGate>
  );
}

function useLeadMutation<T>(id: string, fn: (v: T) => Promise<unknown>, done?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm'] });
      if (done) toast.push(done, 'success');
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      if (e instanceof ApiRequestError && e.code === 'CRM_STALE_VERSION') {
        qc.invalidateQueries({ queryKey: ['crm', 'lead', id] });
      }
    },
  });
}

function Lead() {
  const { id } = useParams<{ id: string }>();
  const lead = useQuery({
    queryKey: ['crm', 'lead', id],
    queryFn: () => api.admin.crm.lead(id),
  });

  if (lead.isError) {
    return (
      <ErrorState
        message={
          lead.error instanceof ApiRequestError && lead.error.status === 404
            ? 'This lead does not exist, or it is not one you can see.'
            : 'We could not load this lead.'
        }
        onRetry={() => lead.refetch()}
      />
    );
  }
  if (!lead.data) return <Skeleton className="h-96" />;
  const l = lead.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title={l.organizationName}
        breadcrumbs={[
          { label: 'Prospects', href: '/admin/acquisition/prospects' },
          { label: l.organizationName },
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StageBadge stage={l.stage} />
            <DerivedBadge derived={l.derived} />
            {l.archivedAt && <Badge tone="neutral">Archived</Badge>}
            <span className="text-caption text-text-muted">
              {l.team.name} - {countryName(l.country)} - in this stage{' '}
              {wholeDays(l.stageChangedAt) === 0
                ? 'since today'
                : `for ${wholeDays(l.stageChangedAt)} days`}
            </span>
          </div>
        }
        action={l.access.manage ? <ArchiveButton lead={l} /> : undefined}
      />

      <div
        role="status"
        className={`rounded-lg border p-4 text-sm ${
          followUpState(l.nextFollowUpAt) === 'overdue' && !['LOST', 'ACTIVATED'].includes(l.stage)
            ? 'border-status-error/30 bg-status-error/5 text-status-error'
            : 'border-border bg-background-surface text-text-secondary'
        }`}
      >
        <span className="font-medium">Next action: </span>
        {nextActionText(l)}
        {l.assignedTo ? ` - assigned to ${l.assignedTo.fullName}` : ' - nobody is assigned yet'}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <LogActivity lead={l} />
          <Timeline lead={l} />
          <Details lead={l} />
        </div>
        <div className="space-y-6">
          <StageCard lead={l} />
          {l.access.manage && <AssignCard lead={l} />}
          <FollowUps lead={l} />
          <Conversion lead={l} />
        </div>
      </div>
    </div>
  );
}

function ArchiveButton({ lead }: { lead: CrmLeadDetail }) {
  const m = useLeadMutation(
    lead.id,
    () => api.admin.crm.archive(lead.id, { version: lead.version, archived: !lead.archivedAt }),
    lead.archivedAt ? 'Lead restored.' : 'Lead archived.',
  );
  return (
    <Button variant="outline" loading={m.isPending} onClick={() => m.mutate(undefined)}>
      {lead.archivedAt ? 'Restore lead' : 'Archive lead'}
    </Button>
  );
}

/** Log something that already happened. It is a record; nothing is sent to the prospect. */
function LogActivity({ lead }: { lead: CrmLeadDetail }) {
  const [type, setType] = useState<string>('CALL');
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(new Date()));
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [withFollowUp, setWithFollowUp] = useState(true);
  const [dueAt, setDueAt] = useState(() => toLocalInput(new Date(Date.now() + 2 * 86_400_000)));
  const [title, setTitle] = useState('Follow up');
  const m = useLeadMutation(
    lead.id,
    () =>
      api.admin.crm.logActivity(lead.id, {
        type,
        occurredAt: fromLocalInput(occurredAt),
        outcome: outcome || null,
        notes,
        followUp: withFollowUp ? { dueAt: fromLocalInput(dueAt), title } : undefined,
      }),
    'Activity logged.',
  );
  return (
    <Card title="Log an activity">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate(undefined, { onSuccess: () => setNotes('') });
        }}
      >
        <p className="text-caption text-text-muted">
          Record outreach you already did. ETicketsGo does not send anything to the prospect.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="What" value={type} onChange={(e) => setType(e.target.value)}>
            {CRM_ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {activityLabel(t)}
              </option>
            ))}
          </Select>
          <Input
            label="When"
            type="datetime-local"
            value={occurredAt}
            max={toLocalInput(new Date())}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
          <Select label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">Not recorded</option>
            {CRM_ACTIVITY_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {outcomeLabel(o)}
              </option>
            ))}
          </Select>
        </div>
        <Textarea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={withFollowUp}
            onChange={(e) => setWithFollowUp(e.target.checked)}
          />
          Schedule a follow-up for me
        </label>
        {withFollowUp && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Follow up on"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
            <Input label="What to do" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        )}
        <div className="flex justify-end">
          <Button type="submit" loading={m.isPending}>
            Log activity
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Timeline({ lead }: { lead: CrmLeadDetail }) {
  const items = useMemo(() => {
    const acts = lead.activities.map((a) => ({
      key: `a-${a.id}`,
      at: a.occurredAt,
      title: `${activityLabel(a.type)}${a.outcome ? ` - ${outcomeLabel(a.outcome)}` : ''}`,
      by: a.responsible.fullName,
      notes: a.notes,
    }));
    const moves = lead.stageHistory.map((s) => ({
      key: `s-${s.id}`,
      at: s.createdAt,
      title: s.fromStage
        ? `Moved from ${stageLabel(s.fromStage)} to ${stageLabel(s.toStage)}`
        : `Added as ${stageLabel(s.toStage)}`,
      by: s.changedBy?.fullName ?? 'Former staff',
      notes: s.note,
    }));
    return [...acts, ...moves].sort((a, b) => b.at.localeCompare(a.at));
  }, [lead]);
  return (
    <Card title="History">
      <p className="mb-3 text-caption text-text-muted">{LOGGED_NOT_SENT}</p>
      {items.length === 0 ? (
        <EmptyState compact title="Nothing logged yet" />
      ) : (
        <ol className="space-y-3">
          {items.map((i) => (
            <li key={i.key} className="border-l-2 border-border pl-3 text-sm">
              <p className="font-medium text-text-primary">{i.title}</p>
              <p className="text-caption text-text-muted">
                {recordedAt(i.at)} - {i.by}
              </p>
              {i.notes && <p className="mt-1 whitespace-pre-line text-text-secondary">{i.notes}</p>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function StageCard({ lead }: { lead: CrmLeadDetail }) {
  const [stage, setStage] = useState('');
  const [note, setNote] = useState('');
  const [lostReason, setLostReason] = useState('');
  const m = useLeadMutation(
    lead.id,
    () =>
      api.admin.crm.changeStage(lead.id, {
        version: lead.version,
        stage,
        note: note || undefined,
        lostReason: lostReason || undefined,
      }),
    'Stage changed.',
  );
  const reopening = lead.stage === 'LOST';
  return (
    <Card title="Pipeline stage">
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          Now: <StageBadge stage={lead.stage} />
          {lead.lostReason && <span className="block pt-1">Lost because: {lead.lostReason}</span>}
        </p>
        {lead.allowedStages.length === 0 ? (
          <p className="text-caption text-text-muted">
            {reopening ? 'Only a manager can reopen a lost lead.' : 'There is no next stage.'}
          </p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate(undefined, {
                onSuccess: () => {
                  setStage('');
                  setNote('');
                  setLostReason('');
                },
              });
            }}
          >
            <Select label="Move to" value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">Choose a stage</option>
              {lead.allowedStages.map((s) => (
                <option key={s} value={s}>
                  {reopening ? `Reopen as ${stageLabel(s)}` : stageLabel(s)}
                </option>
              ))}
            </Select>
            {stage === 'LOST' && (
              <Input
                label="Why was it lost?"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              />
            )}
            {stage === 'ACTIVATED' && !lead.derived.activated && (
              <p className="text-caption text-status-warning">
                A lead is activated only when it is linked to an organizer account that the
                organizer review has approved. This one is not yet.
              </p>
            )}
            <Input
              label={reopening ? 'Why reopen it?' : 'Note (optional)'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button type="submit" disabled={!stage} loading={m.isPending}>
              Move
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

function AssignCard({ lead }: { lead: CrmLeadDetail }) {
  const teams = useQuery({ queryKey: ['crm', 'teams'], queryFn: () => api.admin.crm.teams() });
  const members = teams.data?.find((t) => t.id === lead.teamId)?.members ?? [];
  const [to, setTo] = useState(lead.assignedToUserId ?? '');
  const m = useLeadMutation(
    lead.id,
    () => api.admin.crm.assign(lead.id, { version: lead.version, assignedToUserId: to || null }),
    'Assignment saved.',
  );
  return (
    <Card title="Assigned to">
      <div className="space-y-3">
        <Select label="Team member" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Nobody (unassigned)</option>
          {members
            .filter((x) => x.holdsAgent !== false)
            .map((x) => (
              <option key={x.userId} value={x.userId}>
                {x.fullName}
                {x.role === 'MANAGER' ? ' (manager)' : ''}
              </option>
            ))}
        </Select>
        <Button
          variant="outline"
          disabled={to === (lead.assignedToUserId ?? '')}
          loading={m.isPending}
          onClick={() => m.mutate(undefined)}
        >
          Save assignment
        </Button>
      </div>
    </Card>
  );
}

function FollowUps({ lead }: { lead: CrmLeadDetail }) {
  const open = lead.followUps.filter((f) => f.status === 'OPEN');
  const closed = lead.followUps.filter((f) => f.status !== 'OPEN').slice(0, 5);
  const [dueAt, setDueAt] = useState(() => toLocalInput(new Date(Date.now() + 86_400_000)));
  const [title, setTitle] = useState('');
  const add = useLeadMutation(
    lead.id,
    () => api.admin.crm.createFollowUp(lead.id, { dueAt: fromLocalInput(dueAt), title }),
    'Follow-up scheduled.',
  );
  const done = useLeadMutation(lead.id, (f: { id: string; version: number }) =>
    api.admin.crm.completeFollowUp(f.id, { version: f.version }),
  );
  const cancel = useLeadMutation(lead.id, (f: { id: string; version: number }) =>
    api.admin.crm.cancelFollowUp(f.id, { version: f.version }),
  );
  return (
    <Card title="Follow-ups">
      <div className="space-y-4">
        {open.length === 0 ? (
          <p className="text-sm text-text-muted">No follow-up scheduled.</p>
        ) : (
          <ul className="space-y-2">
            {open.map((f) => (
              <li key={f.id} className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium text-text-primary">{f.title}</p>
                <p
                  className={`text-caption ${
                    followUpState(f.dueAt) === 'overdue' ? 'text-status-error' : 'text-text-muted'
                  }`}
                >
                  {followUpState(f.dueAt) === 'overdue' ? 'Overdue: ' : 'Due '}
                  {recordedAt(f.dueAt)} - {f.owner.fullName}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" loading={done.isPending} onClick={() => done.mutate(f)}>
                    Done
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={cancel.isPending}
                    onClick={() => cancel.mutate(f)}
                  >
                    Cancel
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, { onSuccess: () => setTitle('') });
          }}
        >
          <Input
            label="New follow-up"
            placeholder="What to do"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Input
            label="When"
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={title.trim().length < 2}
            loading={add.isPending}
          >
            Schedule
          </Button>
        </form>
        {closed.length > 0 && (
          <div>
            <p className="mb-1 text-caption font-medium text-text-secondary">Recently closed</p>
            <ul className="space-y-1 text-caption text-text-muted">
              {closed.map((f) => (
                <li key={f.id}>
                  {f.status === 'DONE' ? 'Done' : 'Cancelled'}: {f.title} ({dateOnly(f.dueAt)})
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

/** What the lead became, from the platform's own records. Linking never creates an organizer. */
function Conversion({ lead }: { lead: CrmLeadDetail }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const search = useQuery({
    queryKey: ['crm', 'org-search', term],
    queryFn: () => api.admin.crm.searchOrganizations(term),
    enabled: lead.access.manage && term.length >= 2,
  });
  const link = useLeadMutation(
    lead.id,
    (organizationId: string) =>
      api.admin.crm.linkOrganization(lead.id, { version: lead.version, organizationId }),
    'Linked to the organizer account.',
  );
  const unlink = useLeadMutation(
    lead.id,
    () => api.admin.crm.unlinkOrganization(lead.id, { version: lead.version }),
    'Link removed.',
  );
  const d = lead.derived;
  return (
    <Card title="Organizer account">
      <div className="space-y-3 text-sm">
        {d.organization ? (
          <dl className="space-y-1">
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Account</dt>
              <dd className="text-right font-medium text-text-primary">{d.organization.name}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Review status</dt>
              <dd>
                <Badge tone={d.activated ? 'success' : 'warning'}>
                  {d.organization.status.charAt(0) + d.organization.status.slice(1).toLowerCase()}
                </Badge>
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Signed up</dt>
              <dd>{dateOnly(d.organization.createdAt)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">First published event</dt>
              <dd>{d.firstPublishedEventAt ? dateOnly(d.firstPublishedEventAt) : 'None yet'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Published events</dt>
              <dd className="tabular-nums">{d.publishedEventCount}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-text-muted">
            Not linked. When the organizer signs up and creates their account, a manager links it
            here. The CRM never creates or approves an organizer.
          </p>
        )}
        <p className="text-caption text-text-muted">
          These facts come from the organizer account and its events, not from the stage above.
        </p>
        {lead.access.manage && (
          <div className="space-y-2 border-t border-border pt-3">
            {d.organization && (
              <Button
                variant="ghost"
                size="sm"
                loading={unlink.isPending}
                onClick={() => unlink.mutate(undefined)}
              >
                Remove link
              </Button>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setTerm(q.trim());
              }}
              className="flex gap-2"
            >
              <Input
                aria-label="Find an organizer account"
                placeholder="Name, slug or contact email"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <Button type="submit" variant="outline">
                Find
              </Button>
            </form>
            {search.data && search.data.length === 0 && (
              <p className="text-caption text-text-muted">No organizer account matches.</p>
            )}
            <ul className="space-y-1">
              {search.data?.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium text-text-primary">{o.name}</span>{' '}
                    <span className="text-caption text-text-muted">
                      {o.slug} - {o.status.toLowerCase()}
                    </span>
                  </span>
                  {o.alreadyLinked ? (
                    <Badge tone="neutral">Already linked</Badge>
                  ) : (
                    <Button size="sm" loading={link.isPending} onClick={() => link.mutate(o.id)}>
                      Link
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

const editable = [
  ['organizationName', 'Organization name'],
  ['category', 'Category'],
  ['website', 'Website'],
  ['city', 'City'],
  ['state', 'State'],
  ['timezone', 'Timezone (e.g. Asia/Kolkata)'],
  ['contactName', 'Contact name'],
  ['contactTitle', 'Contact title'],
  ['email', 'Business email'],
  ['phone', 'Phone'],
] as const;

function Details({ lead }: { lead: CrmLeadDetail }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [dupes, setDupes] = useState<CrmDuplicateMatch[]>([]);
  const qc = useQueryClient();
  const toast = useToast();
  const start = () => {
    setForm({
      ...Object.fromEntries(editable.map(([k]) => [k, (lead[k] as string | null) ?? ''])),
      source: lead.source,
      priority: lead.priority,
      notes: lead.notes ?? '',
      tags: lead.tags.join(', '),
      socialLinks: lead.socialLinks.join('\n'),
    });
    setEditing(true);
  };
  const save = useMutation({
    mutationFn: () =>
      api.admin.crm.updateLead(lead.id, {
        version: lead.version,
        ...Object.fromEntries(editable.map(([k]) => [k, form[k] ?? ''])),
        timezone: form.timezone ? form.timezone : null,
        source: form.source,
        priority: form.priority,
        notes: form.notes,
        tags: form.tags
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        socialLinks: form.socialLinks
          .split(/\s+/)
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['crm'] });
      setDupes(r.duplicates);
      setEditing(false);
      toast.push('Saved.', 'success');
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      if (e instanceof ApiRequestError && e.code === 'CRM_STALE_VERSION') {
        qc.invalidateQueries({ queryKey: ['crm', 'lead', lead.id] });
        setEditing(false);
      }
    },
  });
  return (
    <Card
      title="Details"
      action={
        !editing && (
          <Button variant="outline" size="sm" onClick={start}>
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {editable.map(([k, label]) => (
              <Input
                key={k}
                label={label}
                value={form[k] ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              />
            ))}
            <Select
              label="Source"
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
            >
              {CRM_LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {sourceLabel(s)}
                </option>
              ))}
            </Select>
            <Select
              label="Priority"
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
            >
              {CRM_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0) + p.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
            <Input
              label="Tags (comma separated)"
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
            />
          </div>
          <Textarea
            label="Social links (one per line, https://...)"
            rows={2}
            value={form.socialLinks}
            onChange={(e) => setForm((f) => ({ ...f, socialLinks: e.target.value }))}
          />
          <Textarea
            label="Notes"
            rows={3}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {editable.map(([k, label]) => (
              <div key={k}>
                <dt className="text-caption text-text-muted">{label}</dt>
                <dd className="break-words text-text-primary">
                  {(lead[k] as string | null) || '-'}
                </dd>
              </div>
            ))}
            <div>
              <dt className="text-caption text-text-muted">Source</dt>
              <dd>{sourceLabel(lead.source)}</dd>
            </div>
            <div>
              <dt className="text-caption text-text-muted">Priority</dt>
              <dd>{lead.priority.charAt(0) + lead.priority.slice(1).toLowerCase()}</dd>
            </div>
            <div>
              <dt className="text-caption text-text-muted">Tags</dt>
              <dd>{lead.tags.length ? lead.tags.join(', ') : '-'}</dd>
            </div>
            <div>
              <dt className="text-caption text-text-muted">Added</dt>
              <dd>{recordedAt(lead.createdAt)}</dd>
            </div>
          </dl>
          {lead.socialLinks.length > 0 && (
            <ul className="text-sm">
              {lead.socialLinks.map((s) => (
                <li key={s}>
                  <a
                    className="break-all underline"
                    href={s}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {s}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {lead.notes && (
            <p className="whitespace-pre-line text-sm text-text-secondary">{lead.notes}</p>
          )}
          <DuplicateList matches={dupes} />
        </div>
      )}
    </Card>
  );
}
