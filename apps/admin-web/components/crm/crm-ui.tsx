'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  ApiRequestError,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Select,
  Textarea,
  errorMessage,
  useAuthUser,
  useToast,
  type CrmDuplicateMatch,
  type CrmMe,
} from '@eticketsgo/web-kit';
import { CRM_LEAD_SOURCES, CRM_PRIORITIES } from '@eticketsgo/shared-types';
import {
  NO_CRM_ACCESS,
  NO_CRM_MANAGER_ACCESS,
  countryName,
  crmAccess,
  ratioText,
  sourceLabel,
  stageLabel,
  stageTone,
  type Ratio,
} from '../../lib/crm';

/**
 * Shared pieces of the Organizer Acquisition pages.
 *
 * The API decides what anybody may see (CRM_AGENT / CRM_MANAGER plus team membership); these
 * only keep the console from offering what it would refuse.
 */

export function useCrmMe() {
  const { user } = useAuthUser();
  const access = crmAccess(user);
  const query = useQuery({
    queryKey: ['crm', 'me'],
    queryFn: () => api.admin.crm.me(),
    enabled: access.agent,
    staleTime: 60_000,
  });
  return { access, me: query.data as CrmMe | undefined, loading: query.isLoading };
}

/** Renders the page only for somebody holding the duty; otherwise says what is needed. */
export function CrmGate({ manager = false, children }: { manager?: boolean; children: ReactNode }) {
  const { user, isLoading } = useAuthUser();
  if (isLoading || !user) return null;
  const access = crmAccess(user);
  if (!access.agent || (manager && !access.manager)) {
    return (
      <Card>
        <p className="text-text-secondary">{manager ? NO_CRM_MANAGER_ACCESS : NO_CRM_ACCESS}</p>
      </Card>
    );
  }
  return <>{children}</>;
}

/** What to show when the caller is on no team: the API answers with empty lists. */
export function NoTeamNotice({ me }: { me: CrmMe | undefined }) {
  if (!me || me.isSuperAdmin || me.teams.length > 0) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-4 text-sm text-text-secondary"
    >
      You are not on an acquisition team yet, so there are no leads to show. Ask your manager or a
      super admin to add you to the India or USA team.
    </div>
  );
}

export function StageBadge({ stage }: { stage: string }) {
  return <Badge tone={stageTone(stage)}>{stageLabel(stage)}</Badge>;
}

/** A share with its denominator in words. */
export function RatioText({ value, of }: { value: Ratio; of?: string }) {
  return <span className="tabular-nums">{ratioText(value, of)}</span>;
}

/** The derived activation of a lead: from the platform's data, never typed. */
export function DerivedBadge({
  derived,
}: {
  derived: { linked: boolean; activated: boolean; firstPublishedEventAt: string | null };
}) {
  if (!derived.linked) return <Badge tone="neutral">Not linked</Badge>;
  if (!derived.activated) return <Badge tone="warning">Linked, not approved</Badge>;
  if (!derived.firstPublishedEventAt) return <Badge tone="info">Approved</Badge>;
  return <Badge tone="success">Approved, first event live</Badge>;
}

/** Duplicate matches, in words. A match outside your scope says only that it exists. */
export function DuplicateList({ matches }: { matches: CrmDuplicateMatch[] }) {
  if (matches.length === 0) return null;
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-sm"
    >
      <p className="font-medium text-text-primary">
        This looks like a prospect already in the CRM.
      </p>
      <ul className="space-y-1 text-text-secondary">
        {matches.map((m, i) => (
          <li key={m.id ?? i}>
            {m.visible ? (
              <a className="underline" href={`/admin/acquisition/prospects/${m.id}`}>
                {m.organizationName}
              </a>
            ) : (
              <span>A lead held by another team member</span>
            )}{' '}
            <span className="text-text-muted">
              (same {m.matchedOn.join(', ')}
              {m.visible && m.stage ? `, ${stageLabel(m.stage)}` : ''}
              {m.visible && m.assignedTo ? `, with ${m.assignedTo}` : ''})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const blank = {
  organizationName: '',
  contactName: '',
  email: '',
  phone: '',
  website: '',
  city: '',
  source: 'RESEARCH',
  priority: 'MEDIUM',
  notes: '',
};

/**
 * Quick lead entry: the essentials in one dialog, checked for duplicates as you type the name,
 * email or phone. Everything else can be filled in on the lead afterwards.
 */
export function QuickLeadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, access } = useCrmMe();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const teams = useMemo(() => me?.teams ?? [], [me]);
  const [teamId, setTeamId] = useState('');
  const [form, setForm] = useState(blank);
  const [matches, setMatches] = useState<CrmDuplicateMatch[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const team = teams.find((t) => t.id === teamId) ?? teams[0];
  const managesTeam = !!team?.manages;

  useEffect(() => {
    if (!teamId && teams[0]) setTeamId(teams[0].id);
  }, [teamId, teams]);

  // Check for duplicates shortly after the person stops typing.
  useEffect(() => {
    if (!open) return;
    const { organizationName, email, phone, website } = form;
    if (organizationName.trim().length < 3 && !email && !phone && !website) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      api.admin.crm
        .checkDuplicates({
          organizationName: organizationName || undefined,
          email: email || undefined,
          phone: phone || undefined,
          website: website || undefined,
          country: team?.country,
        })
        .then((r) => setMatches(r.matches))
        .catch(() => setMatches([]));
    }, 450);
    return () => clearTimeout(t);
  }, [open, form, team?.country]);

  const create = useMutation({
    mutationFn: (confirmDuplicate: boolean) =>
      api.admin.crm.createLead({
        ...form,
        teamId: team?.id,
        country: team?.country,
        confirmDuplicate: confirmDuplicate || undefined,
      }),
    onSuccess: (lead) => {
      qc.invalidateQueries({ queryKey: ['crm'] });
      toast.push(`${lead.organizationName} added.`, 'success');
      setForm(blank);
      setMatches([]);
      onClose();
      router.push(`/admin/acquisition/prospects/${lead.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiRequestError) {
        const fields = (e.details?.fields ?? {}) as Record<string, string[]>;
        setFieldErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v[0]])));
        if (e.code === 'CRM_DUPLICATE_LEAD') {
          setMatches((e.details?.matches as CrmDuplicateMatch[]) ?? []);
        }
      }
      toast.push(errorMessage(e), 'error');
    },
  });

  const set = (k: keyof typeof blank) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  if (!access.agent) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a prospect"
      description="An organizer we would like to sell for. Only the name is required."
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {matches.length > 0 && managesTeam && (
            <Button
              variant="outline"
              loading={create.isPending}
              onClick={() => create.mutate(true)}
            >
              Add anyway
            </Button>
          )}
          <Button
            loading={create.isPending}
            disabled={!team || form.organizationName.trim().length < 2}
            onClick={() => create.mutate(false)}
          >
            Add prospect
          </Button>
        </div>
      }
    >
      {teams.length === 0 ? (
        <EmptyState
          compact
          title="You are not on an acquisition team"
          hint="Ask your manager or a super admin to add you to the India or USA team."
        />
      ) : (
        <div className="space-y-3">
          {teams.length > 1 && (
            <Select label="Team" value={team?.id ?? ''} onChange={(e) => setTeamId(e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({countryName(t.country)})
                </option>
              ))}
            </Select>
          )}
          <Input
            label="Organization name"
            value={form.organizationName}
            onChange={(e) => set('organizationName')(e.target.value)}
            error={fieldErrors.organizationName}
            autoFocus
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Contact name"
              value={form.contactName}
              onChange={(e) => set('contactName')(e.target.value)}
            />
            <Input label="City" value={form.city} onChange={(e) => set('city')(e.target.value)} />
            <Input
              label="Business email"
              type="email"
              value={form.email}
              onChange={(e) => set('email')(e.target.value)}
              error={fieldErrors.email}
            />
            <Input
              label="Phone"
              type="tel"
              value={form.phone}
              onChange={(e) => set('phone')(e.target.value)}
              error={fieldErrors.phone}
            />
            <Input
              label="Website"
              value={form.website}
              onChange={(e) => set('website')(e.target.value)}
              error={fieldErrors.website}
              placeholder="example.com"
            />
            <Select
              label="Where the lead came from"
              value={form.source}
              onChange={(e) => set('source')(e.target.value)}
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
              onChange={(e) => set('priority')(e.target.value)}
            >
              {CRM_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0) + p.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </div>
          <Textarea
            label="Notes"
            rows={2}
            value={form.notes}
            onChange={(e) => set('notes')(e.target.value)}
          />
          <DuplicateList matches={matches} />
          {matches.length > 0 && !managesTeam && (
            <p className="text-caption text-text-muted">
              If it really is a different organization, ask your manager to add it.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** A labelled number for the KPI rows, with an optional line under it. */
export function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background-surface p-4 shadow-sm">
      <p className="text-caption font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-caption text-text-muted">{hint}</p>}
    </div>
  );
}

/** Report filters shared by Overview and Reports. Dates are calendar days. */
export interface CrmFilterState {
  from: string;
  to: string;
  country: string;
  source: string;
  stage: string;
  assignee: string;
  city: string;
}
export const EMPTY_FILTERS: CrmFilterState = {
  from: '',
  to: '',
  country: '',
  source: '',
  stage: '',
  assignee: '',
  city: '',
};
