'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Download, Plus, Upload } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Textarea,
  errorMessage,
  useToast,
  type Column,
  type CrmImportResult,
  type CrmLead,
  type CrmLeadFilters,
} from '@eticketsgo/web-kit';
import { CRM_LEAD_SOURCES, CRM_LIMITS, CRM_STAGES } from '@eticketsgo/shared-types';
import {
  CrmGate,
  DerivedBadge,
  NoTeamNotice,
  QuickLeadDialog,
  StageBadge,
  useCrmMe,
} from '../../../../components/crm/crm-ui';
import {
  countryName,
  followUpState,
  nextActionText,
  sourceLabel,
  stageLabel,
} from '../../../../lib/crm';

/**
 * Prospects: every lead the caller may see, filtered and paged on the server.
 *
 * The "next action" column is the point of the list: an agent should know what to do about a
 * lead without opening it.
 */
export default function ProspectsPage() {
  return (
    <CrmGate>
      <Prospects />
    </CrmGate>
  );
}

function Prospects() {
  const router = useRouter();
  const params = useSearchParams();
  const { me, access } = useCrmMe();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [stage, setStage] = useState(params.get('stage') ?? '');
  const [country, setCountry] = useState('');
  const [source, setSource] = useState('');
  const [assignee, setAssignee] = useState(access.manager ? '' : 'me');
  const [followUp, setFollowUp] = useState(params.get('followUp') ?? '');
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const toast = useToast();
  const countries = [...new Set((me?.teams ?? []).map((t) => t.country))];
  const managedTeams = (me?.teams ?? []).filter((t) => t.manages);

  const filters: CrmLeadFilters = {
    page,
    pageSize: 25,
    q: applied || undefined,
    stage: stage || undefined,
    country: country || undefined,
    source: source || undefined,
    assignee: assignee || undefined,
    followUp: (followUp || undefined) as CrmLeadFilters['followUp'],
    archived: archived || undefined,
  };
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['crm', 'leads', filters],
    queryFn: () => api.admin.crm.leads(filters),
  });

  const columns: Column<CrmLead>[] = [
    {
      key: 'org',
      header: 'Organization',
      render: (l) => (
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-text-primary">{l.organizationName}</p>
          <p className="text-caption text-text-muted">
            {[l.city, countryName(l.country), l.contactName].filter(Boolean).join(' - ')}
          </p>
        </div>
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
      className: 'whitespace-nowrap',
      render: (l) => (
        <div className="space-y-1">
          <StageBadge stage={l.stage} />
          {l.organizationId && <DerivedBadge derived={l.derived} />}
        </div>
      ),
    },
    {
      key: 'next',
      header: 'Next action',
      render: (l) => (
        <span
          className={
            followUpState(l.nextFollowUpAt) === 'overdue' &&
            !['LOST', 'ACTIVATED'].includes(l.stage)
              ? 'font-medium text-status-error'
              : 'text-text-secondary'
          }
        >
          {nextActionText(l)}
        </span>
      ),
    },
    {
      key: 'owner',
      header: 'Assigned to',
      className: 'whitespace-nowrap',
      render: (l) =>
        l.assignedTo ? (
          <span className="text-text-secondary">{l.assignedTo.fullName}</span>
        ) : (
          <Badge tone="warning">Unassigned</Badge>
        ),
    },
    {
      key: 'source',
      header: 'Source',
      className: 'whitespace-nowrap',
      render: (l) => <span className="text-caption text-text-muted">{sourceLabel(l.source)}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prospects"
        description="Organizers we would like to sell for. Search, filter and open one to work it."
        action={
          <div className="flex flex-wrap gap-2">
            {access.manager && managedTeams.length > 0 && (
              <>
                <Button variant="outline" icon={Upload} onClick={() => setImporting(true)}>
                  Import CSV
                </Button>
                <Button
                  variant="outline"
                  icon={Download}
                  onClick={() =>
                    api.admin.crm
                      .downloadLeads({ ...filters, page: undefined, pageSize: undefined })
                      .catch((e) => toast.push(errorMessage(e), 'error'))
                  }
                >
                  Export CSV
                </Button>
              </>
            )}
            <Button icon={Plus} onClick={() => setAdding(true)}>
              Add prospect
            </Button>
          </div>
        }
      />
      <NoTeamNotice me={me} />

      <Card padding="md">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="md:col-span-2">
            <SearchInput
              value={q}
              onChange={setQ}
              onSubmit={() => {
                setApplied(q.trim());
                setPage(1);
              }}
              placeholder="Search organization, contact, email, city or website"
            />
          </div>
          <Select
            aria-label="Stage"
            value={stage}
            onChange={(e) => reset(setStage)(e.target.value)}
          >
            <option value="">Every stage</option>
            {CRM_STAGES.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Follow-up"
            value={followUp}
            onChange={(e) => reset(setFollowUp)(e.target.value)}
          >
            <option value="">Any follow-up</option>
            <option value="overdue">Follow-up overdue</option>
            <option value="upcoming">Follow-up scheduled</option>
            <option value="none">No follow-up set</option>
          </Select>
          {access.manager && (
            <Select
              aria-label="Assigned to"
              value={assignee}
              onChange={(e) => reset(setAssignee)(e.target.value)}
            >
              <option value="">Anybody</option>
              <option value="me">Me</option>
              <option value="none">Unassigned</option>
            </Select>
          )}
          {countries.length > 1 && (
            <Select
              aria-label="Country"
              value={country}
              onChange={(e) => reset(setCountry)(e.target.value)}
            >
              <option value="">India and USA</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {countryName(c)}
                </option>
              ))}
            </Select>
          )}
          <Select
            aria-label="Source"
            value={source}
            onChange={(e) => reset(setSource)(e.target.value)}
          >
            <option value="">Every source</option>
            {CRM_LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => reset(setArchived)(e.target.checked)}
            />
            Show archived leads
          </label>
        </div>
      </Card>

      <Card
        title={archived ? 'Archived prospects' : 'Prospects'}
        action={data ? <Badge tone="neutral">{data.meta.total} matching</Badge> : undefined}
      >
        <DataTable
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          error={isError ? 'We could not load the prospects. Please try again.' : undefined}
          onRetry={() => refetch()}
          empty={
            <EmptyState
              title="No prospect matches"
              hint="Clear a filter, or add the first prospect with Add prospect."
            />
          }
          rowKey={(l) => l.id}
          onRowClick={(l) => router.push(`/admin/acquisition/prospects/${l.id}`)}
          mobile="cards"
        />
        {data && data.meta.totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              onChange={setPage}
            />
          </div>
        )}
      </Card>

      <QuickLeadDialog open={adding} onClose={() => setAdding(false)} />
      {importing && (
        <ImportDialog
          teams={managedTeams.map((t) => ({
            id: t.id,
            label: `${t.name} (${countryName(t.country)})`,
          }))}
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}

/**
 * CSV import in two steps: check the file (nothing is written), then import the rows that
 * passed. The server checks every row again on import; the preview is only a preview.
 */
function ImportDialog({
  teams,
  onClose,
}: {
  teams: { id: string; label: string }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [csv, setCsv] = useState('');
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'create'>('skip');
  const [result, setResult] = useState<CrmImportResult | null>(null);

  const run = useMutation({
    mutationFn: (commit: boolean) =>
      api.admin.crm.importLeads({ teamId, csv, commit, onDuplicate }),
    onSuccess: (r) => {
      setResult(r);
      if (r.committed) {
        qc.invalidateQueries({ queryKey: ['crm'] });
        toast.push(`Imported ${r.summary.created} prospects.`, 'success');
      }
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    setCsv(await file.text());
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Import prospects from a CSV file"
      description={`Up to ${CRM_LIMITS.importRowsMax} rows at a time. The first row must name the columns, including Organization name.`}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="outline"
            disabled={!csv || !teamId}
            loading={run.isPending && !result}
            onClick={() => run.mutate(false)}
          >
            Check the file
          </Button>
          <Button
            disabled={!result || result.committed || result.summary.willCreate === 0}
            loading={run.isPending && !!result}
            onClick={() => run.mutate(true)}
          >
            {result && !result.committed
              ? `Import ${result.summary.willCreate} prospects`
              : 'Import'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
          <Select
            label="Rows that match an existing lead"
            value={onDuplicate}
            onChange={(e) => {
              setOnDuplicate(e.target.value as 'skip' | 'create');
              setResult(null);
            }}
          >
            <option value="skip">Skip them</option>
            <option value="create">Import them anyway</option>
          </Select>
        </div>
        <div>
          <label
            className="mb-1.5 block text-sm font-medium text-text-primary"
            htmlFor="crm-csv-file"
          >
            CSV file
          </label>
          <input
            id="crm-csv-file"
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={(e) => readFile(e.target.files?.[0])}
          />
        </div>
        <Textarea
          label="Or paste the CSV here"
          rows={5}
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setResult(null);
          }}
          hint="Columns we read: Organization name, Category, Website, City, State, Country, Timezone, Contact name, Title, Email, Phone, Social links, Source, Priority, Notes, Tags, Assignee (an email)."
        />
        {result && (
          <div className="space-y-2" aria-live="polite">
            <p className="text-sm text-text-primary">
              {result.committed
                ? `Imported ${result.summary.created} of ${result.summary.rows} rows.`
                : `${result.summary.rows} rows: ${result.summary.ok} ready, ${result.summary.duplicates} match an existing lead, ${result.summary.errors} have errors. ${result.summary.willCreate} would be imported.`}
            </p>
            {result.ignoredColumns.length > 0 && (
              <p className="text-caption text-text-muted">
                Columns not read: {result.ignoredColumns.join(', ')}
              </p>
            )}
            <div className="max-h-64 overflow-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-background-subtle text-caption text-text-secondary">
                  <tr>
                    <th className="px-3 py-2">Line</th>
                    <th className="px-3 py-2">Organization</th>
                    <th className="px-3 py-2">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="px-3 py-1.5 tabular-nums text-text-muted">{r.line}</td>
                      <td className="px-3 py-1.5 text-text-primary">{r.organizationName ?? '-'}</td>
                      <td className="px-3 py-1.5">
                        {r.status === 'ok' && (
                          <Badge tone="success">{r.created ? 'Imported' : 'Ready'}</Badge>
                        )}
                        {r.status === 'duplicate' && (
                          <span className="text-text-secondary">
                            <Badge tone="warning">
                              {r.duplicateOf === 'file'
                                ? 'Repeats an earlier row'
                                : 'Already in the CRM'}
                            </Badge>{' '}
                            same {r.matchedOn?.join(', ')}
                            {r.created ? ' (imported anyway)' : ''}
                          </span>
                        )}
                        {r.status === 'error' && (
                          <span className="text-status-error">{r.errors?.join('; ')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
