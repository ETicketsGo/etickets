'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BadgePercent, Plus } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  Input,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Skeleton,
  Textarea,
  dateTime,
  errorMessage,
  money,
  useToast,
  type Column,
} from '@eticketsgo/web-kit';
import { NO_READ_ACCESS, READ_ONLY_NOTE, useConfigAccess, useHolds } from '@/lib/capabilities';
import {
  BLANK_DRAFT,
  HISTORY_LABEL,
  KIND_LABEL,
  MIN_REASON,
  STATUS_LABEL,
  STATUS_TONE,
  canDeactivate,
  conflictingPolicyId,
  currencyRequired,
  currencyScopeLabel,
  draftToCreateBody,
  draftToTerms,
  feePolicyApi,
  isConflict,
  ordersLabel,
  termsLabel,
  toMinorUnits,
  type DraftErrors,
  type FeeLines,
  type FeeMode,
  type FeePolicyDraft,
  type FeePolicyEffectiveStatus,
  type FeePolicyKind,
  type FeePolicyPreview,
  type FeePolicyScope,
  type PlatformFeePolicyView,
} from '@/lib/fee-policies';

/**
 * Platform fee policies: an exception to the booking fee schedule for one event or one
 * organizer. Waive the booking fee, charge a fixed one, or charge a different percentage, for a
 * window of time and optionally a number of orders.
 *
 * The page opens with PLATFORM_CONFIG_READ (list, history, preview). Creating and switching off
 * need PLATFORM_CONFIG and a fresh authenticator code; the code is asked for by the console's
 * step-up dialog when the API says so (`lib/fee-policies.ts`, `lib/step-up-bridge.ts`).
 *
 * A policy is never edited. To change terms, switch it off and create a new one, so every
 * booking can still be explained by the policy it was charged under.
 */

const PAGE_SIZE = 25;
const STATUSES: FeePolicyEffectiveStatus[] = [
  'ACTIVE',
  'SCHEDULED',
  'EXPIRED',
  'EXHAUSTED',
  'INACTIVE',
];

function PolicyStatus({ status }: { status: FeePolicyEffectiveStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

function ScopeBadge({ scope }: { scope: FeePolicyScope }) {
  return <Badge tone="info">{scope === 'EVENT' ? 'Event' : 'Organizer'}</Badge>;
}

function targetName(p: PlatformFeePolicyView): string {
  if (p.scope === 'EVENT') return p.eventTitle ?? p.eventId ?? 'Unknown event';
  return p.organizationName ?? p.organizationId;
}

export default function AdminFeePolicies() {
  const access = useConfigAccess();
  const mayEdit = access.mayEdit;
  const [scope, setScope] = useState<'' | FeePolicyScope>('');
  const [status, setStatus] = useState<'' | FeePolicyEffectiveStatus>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<PlatformFeePolicyView | null>(null);

  const list = useQuery({
    queryKey: ['admin', 'fee-policies', { scope, status, q, page }],
    queryFn: () =>
      feePolicyApi.list({
        scope: scope || undefined,
        status: status || undefined,
        q: q || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    enabled: access.mayRead,
    placeholderData: (prev) => prev,
  });

  if (!access.known || !access.mayRead) {
    return (
      <div className="space-y-6">
        <PageHeader title="Platform fee policies" />
        <Card>
          <p className="text-sm text-text-secondary">
            {access.known ? NO_READ_ACCESS : 'Loading...'}
          </p>
        </Card>
      </div>
    );
  }

  const filtered = !!(scope || status || q);

  const columns: Column<PlatformFeePolicyView>[] = [
    {
      key: 'target',
      header: 'Applies to',
      render: (p) => (
        <div className="min-w-0 space-y-1">
          <ScopeBadge scope={p.scope} />
          <p className="font-medium text-text-primary [overflow-wrap:anywhere]">{targetName(p)}</p>
          {p.scope === 'EVENT' && p.organizationName && (
            <p className="text-xs text-text-muted">{p.organizationName}</p>
          )}
        </div>
      ),
    },
    {
      key: 'terms',
      header: 'Terms',
      render: (p) => (
        <div>
          <p className="tabular-nums text-text-primary">{termsLabel(p)}</p>
          <p className="text-xs text-text-muted">{currencyScopeLabel(p.currency)}</p>
        </div>
      ),
    },
    {
      key: 'window',
      header: 'Window',
      render: (p) => (
        <div className="text-xs text-text-secondary">
          <p>Starts {dateTime(p.startsAt)}</p>
          <p>{p.endsAt ? `Ends ${dateTime(p.endsAt)}` : 'No end date'}</p>
        </div>
      ),
    },
    {
      key: 'orders',
      header: 'Orders',
      render: (p) => (
        <div className="text-xs text-text-secondary">
          <p className="tabular-nums">{ordersLabel(p)}</p>
          <p className="tabular-nums text-text-muted">
            {p.bookingCount} booking{p.bookingCount === 1 ? '' : 's'}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => <PolicyStatus status={p.effectiveStatus} />,
    },
    {
      key: 'created',
      header: 'Created',
      render: (p) => (
        <div className="text-xs text-text-secondary">
          <p>{p.createdByName ?? 'Unknown'}</p>
          <p className="text-text-muted">{dateTime(p.createdAt)}</p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setHistoryId(p.id)}>
            History
          </Button>
          {mayEdit && canDeactivate(p) && (
            <Button size="sm" variant="danger" onClick={() => setDeactivating(p)}>
              Deactivate
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform fee policies"
        description="Change the booking fee for one event or one organizer. Every change is recorded."
        action={
          mayEdit ? (
            <Button icon={Plus} onClick={() => setCreating(true)}>
              New policy
            </Button>
          ) : undefined
        }
      />

      {!mayEdit && <p className="text-sm text-text-secondary">{READ_ONLY_NOTE}</p>}

      <Card>
        <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
          <li>A policy changes only the platform booking fee.</li>
          <li>Payment processing and tax are not waived.</li>
          <li>An event policy wins over an organizer policy.</li>
          <li>A policy cannot be edited. To change it, deactivate it and create a new one.</li>
        </ul>
      </Card>

      <div className="grid gap-3 md:grid-cols-[1fr_180px_200px]">
        <SearchInput
          value={search}
          onChange={setSearch}
          onSubmit={() => {
            setQ(search.trim());
            setPage(1);
          }}
          placeholder="Search event or organizer"
        />
        <Select
          aria-label="Applies to"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as '' | FeePolicyScope);
            setPage(1);
          }}
        >
          <option value="">Events and organizers</option>
          <option value="EVENT">Events</option>
          <option value="ORGANIZATION">Organizers</option>
        </Select>
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as '' | FeePolicyEffectiveStatus);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.data}
        loading={list.isLoading}
        error={
          list.isError ? `We could not load fee policies. ${errorMessage(list.error)}` : undefined
        }
        onRetry={() => void list.refetch()}
        empty={
          filtered ? (
            <EmptyState compact title="No fee policies match these filters" />
          ) : (
            <EmptyState
              compact
              icon={BadgePercent}
              title="No fee policies yet"
              hint="Every booking pays the normal booking fee schedule."
            />
          )
        }
        rowKey={(p) => p.id}
        mobile="cards"
      />
      {list.data && (
        <Pagination
          page={list.data.meta.page}
          totalPages={list.data.meta.totalPages}
          onChange={setPage}
        />
      )}

      {mayEdit && (
        <NewPolicyDrawer
          open={creating}
          onClose={() => setCreating(false)}
          onShowPolicy={(id) => {
            // One panel at a time. The draft is kept: "New policy" reopens it as it was.
            setCreating(false);
            setHistoryId(id);
          }}
        />
      )}
      <HistoryDrawer id={historyId} onClose={() => setHistoryId(null)} />
      {mayEdit && <DeactivateDialog policy={deactivating} onClose={() => setDeactivating(null)} />}
    </div>
  );
}

/* ── Choosing the event or organizer ─────────────────────────────────────────────── */

interface TargetOption {
  id: string;
  name: string;
  detail?: string;
}

/**
 * Search for the event or organizer, when this operator can read those lists; the id field is
 * always there too. The event list needs EVENT_REVIEW and the organizer list ORGANIZER_REVIEW,
 * so without them the operator pastes the id from the page that shows it.
 */
function TargetPicker({
  scope,
  value,
  onChange,
  error,
}: {
  scope: FeePolicyScope;
  value: string;
  onChange: (id: string, name: string | null) => void;
  error?: string;
}) {
  const mayFindEvents = useHolds('EVENT_REVIEW');
  const mayFindOrganizers = useHolds('ORGANIZER_REVIEW');
  const maySearch = scope === 'EVENT' ? mayFindEvents : mayFindOrganizers;
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [picked, setPicked] = useState<TargetOption | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  // A new scope is a new kind of target: forget the old search and choice.
  useEffect(() => {
    setText('');
    setTerm('');
    setPicked(null);
  }, [scope]);

  const results = useQuery({
    queryKey: ['admin', 'fee-policies', 'targets', scope, term],
    queryFn: async (): Promise<TargetOption[]> => {
      if (scope === 'EVENT') {
        const r = await api.admin.events({ q: term, page: 1, pageSize: 8 });
        return r.data.map((e) => ({
          id: e.id,
          name: e.title,
          detail: [e.organization?.name, e.venue?.city].filter(Boolean).join(', '),
        }));
      }
      const r = await api.admin.organizers({ q: term, page: 1, pageSize: 8 });
      return r.data.map((o) => ({ id: o.id, name: o.name, detail: o.status }));
    },
    enabled: maySearch && term.length >= 2,
    retry: false,
  });

  const noun = scope === 'EVENT' ? 'event' : 'organizer';

  return (
    <div className="space-y-2">
      {maySearch && (
        <>
          <Input
            label={`Find the ${noun}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={scope === 'EVENT' ? 'Event title' : 'Organizer name'}
            hint="Type at least 2 letters."
          />
          {term.length >= 2 && (
            <div className="rounded-md border border-border">
              {results.isLoading ? (
                <p className="p-3 text-sm text-text-muted">Searching...</p>
              ) : results.isError ? (
                <p className="p-3 text-sm text-status-error">
                  The search did not work. Paste the id below instead.
                </p>
              ) : (results.data ?? []).length === 0 ? (
                <p className="p-3 text-sm text-text-muted">Nothing found.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {(results.data ?? []).map((o) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        className={`w-full px-3 py-2 text-left text-sm hover:bg-background-subtle ${
                          o.id === value ? 'bg-background-subtle' : ''
                        }`}
                        onClick={() => {
                          setPicked(o);
                          onChange(o.id, o.name);
                        }}
                      >
                        <span className="font-medium text-text-primary">{o.name}</span>
                        {o.detail && (
                          <span className="block text-xs text-text-muted">{o.detail}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      <Input
        label={
          maySearch ? `Or paste the ${noun} id` : `${scope === 'EVENT' ? 'Event' : 'Organizer'} id`
        }
        value={value}
        onChange={(e) => {
          setPicked(null);
          onChange(e.target.value, null);
        }}
        error={error}
        hint={
          maySearch
            ? undefined
            : `Paste the id of the ${noun}. You can copy it from the ${noun}'s page in this console.`
        }
      />
      {picked && picked.id === value && (
        <p className="text-sm text-text-secondary">
          Chosen: <strong className="text-text-primary">{picked.name}</strong>
        </p>
      )}
    </div>
  );
}

/* ── New policy ──────────────────────────────────────────────────────────────────── */

const FEE_MODES: { value: '' | FeeMode; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'CUSTOMER_PAYS', label: 'Customer pays the fees' },
  { value: 'ORGANIZER_PAYS', label: 'Organizer pays the fees' },
  { value: 'SHARED', label: 'Fees are shared' },
];

function NewPolicyDrawer({
  open,
  onClose,
  onShowPolicy,
}: {
  open: boolean;
  onClose: () => void;
  onShowPolicy: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<FeePolicyDraft>(BLANK_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [submitError, setSubmitError] = useState<{ message: string; policyId: string | null }>();
  const [subtotal, setSubtotal] = useState('500.00');
  const [tickets, setTickets] = useState('1');
  const [previewCurrency, setPreviewCurrency] = useState('INR');
  const [feeMode, setFeeMode] = useState<'' | FeeMode>('');
  const [previewError, setPreviewError] = useState<string>();

  const set = (patch: Partial<FeePolicyDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSubmitError(undefined);
  };

  const reset = () => {
    setDraft(BLANK_DRAFT);
    setErrors({});
    setSubmitError(undefined);
    setPreviewError(undefined);
    setSubtotal('500.00');
    setTickets('1');
    setFeeMode('');
    preview.reset();
  };

  const preview = useMutation({
    mutationFn: feePolicyApi.preview,
    onError: (e) => setPreviewError(errorMessage(e)),
  });

  const create = useMutation({
    mutationFn: feePolicyApi.create,
    onSuccess: () => {
      toast.push('Fee policy created.', 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'fee-policies'] });
      reset();
      onClose();
    },
    onError: (e) => {
      const policyId = conflictingPolicyId(e);
      setSubmitError({
        message: isConflict(e)
          ? `${errorMessage(e)} Deactivate the live policy first, or choose dates that do not overlap.`
          : errorMessage(e),
        policyId,
      });
    },
  });

  const currencyForPreview = (draft.currency.trim() || previewCurrency.trim()).toUpperCase();

  const runPreview = () => {
    setPreviewError(undefined);
    const { terms, errors: termErrors } = draftToTerms(draft);
    if (!terms) {
      setErrors(termErrors);
      setPreviewError('Fix the terms above first.');
      return;
    }
    if (!/^[A-Z]{3}$/.test(currencyForPreview)) {
      setPreviewError('Enter a three-letter currency code for the preview, like INR.');
      return;
    }
    const subtotalMinor = toMinorUnits(subtotal, currencyForPreview);
    if (subtotalMinor === null) {
      setPreviewError('Enter the basket subtotal as a number, like 500.00.');
      return;
    }
    const ticketCount = Number(tickets.trim() || '1');
    if (!Number.isInteger(ticketCount) || ticketCount < 0 || ticketCount > 1000) {
      setPreviewError('Enter the number of paid tickets as a whole number, like 1 or 3.');
      return;
    }
    preview.mutate({
      ...terms,
      currency: currencyForPreview,
      subtotalMinor,
      ticketCount,
      ...(feeMode ? { feeMode } : {}),
    });
  };

  const submit = () => {
    const { body, errors: all } = draftToCreateBody(draft);
    setErrors(all);
    if (!body) return;
    create.mutate(body);
  };

  const needsCurrency = currencyRequired(draft);

  return (
    <Drawer
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New fee policy"
      description="Change the booking fee for one event or one organizer."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={submit}>
            Create policy
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-text-primary">Applies to</legend>
          <div className="flex flex-wrap gap-4">
            {(['EVENT', 'ORGANIZATION'] as const).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="radio"
                  name="fee-policy-scope"
                  value={s}
                  checked={draft.scope === s}
                  onChange={() => set({ scope: s, targetId: '' })}
                />
                {s === 'EVENT' ? 'One event' : 'Every event of one organizer'}
              </label>
            ))}
          </div>
        </fieldset>

        <TargetPicker
          scope={draft.scope}
          value={draft.targetId}
          onChange={(id) => set({ targetId: id })}
          error={errors.targetId}
        />

        <Select
          label="Booking fee"
          value={draft.kind}
          onChange={(e) => set({ kind: e.target.value as FeePolicyKind })}
        >
          {(Object.keys(KIND_LABEL) as FeePolicyKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </Select>

        {draft.kind === 'FIXED' && (
          <Input
            label="Fee per order"
            inputMode="decimal"
            value={draft.fixedAmount}
            onChange={(e) => set({ fixedAmount: e.target.value })}
            error={errors.fixedAmount}
            hint="In the currency below, like 10.00."
          />
        )}
        {draft.kind === 'COMBINED' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Percentage of the order"
              inputMode="decimal"
              value={draft.percent}
              onChange={(e) => set({ percent: e.target.value })}
              error={errors.percent}
              hint="For example 3 means 3%."
            />
            <Input
              label="Fixed fee per ticket"
              inputMode="decimal"
              value={draft.fixedAmount}
              onChange={(e) => set({ fixedAmount: e.target.value })}
              error={errors.fixedAmount}
              hint="Charged once for each paid ticket, in the currency below, like 5.00."
            />
          </div>
        )}
        {draft.kind === 'PERCENT' && (
          <div className="space-y-3">
            <Input
              label="Percentage of the order"
              inputMode="decimal"
              value={draft.percent}
              onChange={(e) => set({ percent: e.target.value })}
              error={errors.percent}
              hint="For example 2.5 means 2.5%."
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Lowest fee (optional)"
                inputMode="decimal"
                value={draft.minAmount}
                onChange={(e) => set({ minAmount: e.target.value })}
                error={errors.minAmount}
              />
              <Input
                label="Highest fee (optional)"
                inputMode="decimal"
                value={draft.maxAmount}
                onChange={(e) => set({ maxAmount: e.target.value })}
                error={errors.maxAmount}
              />
            </div>
          </div>
        )}

        <Input
          label={needsCurrency ? 'Currency' : 'Currency (optional)'}
          value={draft.currency}
          maxLength={3}
          onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
          error={errors.currency}
          hint={
            needsCurrency
              ? 'The currency of the amounts above, like INR or USD.'
              : 'Leave empty to apply to orders in any currency.'
          }
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Starts (optional)"
            type="datetime-local"
            value={draft.startsAt}
            onChange={(e) => set({ startsAt: e.target.value })}
            error={errors.startsAt}
            hint="Empty means now."
          />
          <Input
            label="Ends (optional)"
            type="datetime-local"
            value={draft.endsAt}
            onChange={(e) => set({ endsAt: e.target.value })}
            error={errors.endsAt}
            hint="Empty means no end date."
          />
        </div>

        <Input
          label="Order limit (optional)"
          inputMode="numeric"
          value={draft.maxOrders}
          onChange={(e) => set({ maxOrders: e.target.value })}
          error={errors.maxOrders}
          hint="The policy stops after this many orders. Empty means no limit."
        />

        <Textarea
          label="Reason"
          rows={3}
          value={draft.reason}
          onChange={(e) => set({ reason: e.target.value })}
          error={errors.reason}
          hint={`Why this organizer or event gets a different fee. At least ${MIN_REASON} characters.`}
        />
        <Input
          label="Approval reference (optional)"
          value={draft.approvalReference}
          onChange={(e) => set({ approvalReference: e.target.value })}
          hint="For example a ticket number or the email that approved it."
        />

        <section className="space-y-3 rounded-md border border-border p-4" aria-label="Preview">
          <h3 className="text-sm font-semibold text-text-primary">Preview</h3>
          <p className="text-xs text-text-muted">
            See what one sample order would pay. Payment processing and tax are not waived. Tax is
            not included in this preview.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="Order subtotal"
              inputMode="decimal"
              value={subtotal}
              onChange={(e) => setSubtotal(e.target.value)}
            />
            <Input
              label="Paid tickets"
              inputMode="numeric"
              value={tickets}
              hint="Only a per-ticket fee uses this."
              onChange={(e) => setTickets(e.target.value)}
            />
            {draft.currency.trim() ? (
              <Input label="Currency" value={draft.currency} disabled />
            ) : (
              <Input
                label="Currency"
                value={previewCurrency}
                maxLength={3}
                onChange={(e) => setPreviewCurrency(e.target.value.toUpperCase())}
              />
            )}
            <Select
              label="Who pays the fees"
              value={feeMode}
              onChange={(e) => setFeeMode(e.target.value as '' | FeeMode)}
            >
              {FEE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" loading={preview.isPending} onClick={runPreview}>
            Show preview
          </Button>
          {previewError && (
            <p role="alert" className="text-sm text-status-error">
              {previewError}
            </p>
          )}
          {preview.data && !previewError && (
            <PreviewResult preview={preview.data} onShowPolicy={onShowPolicy} />
          )}
        </section>

        {submitError && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-status-error/30 bg-status-error/5 p-3"
          >
            <p className="text-sm text-status-error">{submitError.message}</p>
            {submitError.policyId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onShowPolicy(submitError.policyId!)}
              >
                View the live policy
              </Button>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

const PREVIEW_ROWS: { key: keyof FeeLines; label: string }[] = [
  { key: 'bookingFeeMinor', label: 'Booking fee' },
  { key: 'paymentFeeMinor', label: 'Payment processing' },
  { key: 'customerFeeMinor', label: 'Customer pays in fees' },
  { key: 'organizerFeeMinor', label: 'Organizer pays in fees' },
  { key: 'totalMinor', label: 'Customer pays in total' },
];

function PreviewResult({
  preview,
  onShowPolicy,
}: {
  preview: FeePolicyPreview;
  onShowPolicy: (id: string) => void;
}) {
  const cur = preview.currency;
  return (
    <div className="space-y-3">
      {preview.currentPolicy && (
        <div className="space-y-2 rounded-md bg-tint-warning p-3 text-sm text-status-warning">
          <p>
            <strong>A live policy already exists for this target:</strong>{' '}
            {termsLabel(preview.currentPolicy)} (
            {STATUS_LABEL[preview.currentPolicy.effectiveStatus]}
            ). A new policy that overlaps it will be refused.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onShowPolicy(preview.currentPolicy!.id)}
          >
            View it
          </Button>
        </div>
      )}
      {!preview.appliesToBasket && (
        <p className="rounded-md bg-background-subtle p-3 text-sm text-text-secondary">
          This policy would not change this order. The normal fee is already lower, or the order is
          free.
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-text-muted">
            <th className="py-1 font-medium">For a {money(preview.subtotalMinor, cur)} order</th>
            <th className="py-1 text-right font-medium">Normal schedule</th>
            <th className="py-1 text-right font-medium">With this policy</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {PREVIEW_ROWS.map((r) => (
            <tr key={r.key}>
              <td className="py-1.5 text-text-secondary">{r.label}</td>
              <td className="py-1.5 text-right tabular-nums">
                {money(preview.schedule[r.key], cur)}
              </td>
              <td className="py-1.5 text-right tabular-nums text-text-primary">
                {money(preview.withPolicy[r.key], cur)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-text-primary">
        Booking fee waived on this order:{' '}
        <strong className="tabular-nums">{money(preview.feeWaivedMinor, cur)}</strong>
      </p>
    </div>
  );
}

/* ── History ─────────────────────────────────────────────────────────────────────── */

function HistoryDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['admin', 'fee-policies', 'detail', id],
    queryFn: () => feePolicyApi.get(id!),
    enabled: !!id,
  });
  const p = detail.data;

  return (
    <Drawer open={!!id} onClose={onClose} title="Fee policy history">
      {detail.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : detail.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-status-error">
            We could not load this policy. {errorMessage(detail.error)}
          </p>
          <Button variant="outline" onClick={() => void detail.refetch()}>
            Try again
          </Button>
        </div>
      ) : p ? (
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <ScopeBadge scope={p.scope} />
              <PolicyStatus status={p.effectiveStatus} />
            </div>
            <p className="font-medium text-text-primary [overflow-wrap:anywhere]">
              {targetName(p)}
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-text-muted">Terms</dt>
            <dd className="tabular-nums">{termsLabel(p)}</dd>
            <dt className="text-text-muted">Currency</dt>
            <dd>{currencyScopeLabel(p.currency)}</dd>
            <dt className="text-text-muted">Starts</dt>
            <dd>{dateTime(p.startsAt)}</dd>
            <dt className="text-text-muted">Ends</dt>
            <dd>{p.endsAt ? dateTime(p.endsAt) : 'No end date'}</dd>
            <dt className="text-text-muted">Orders</dt>
            <dd className="tabular-nums">
              {ordersLabel(p)}, {p.bookingCount} booking{p.bookingCount === 1 ? '' : 's'}
            </dd>
            <dt className="text-text-muted">Reason</dt>
            <dd className="[overflow-wrap:anywhere]">{p.reason}</dd>
            {p.approvalReference && (
              <>
                <dt className="text-text-muted">Approval</dt>
                <dd className="[overflow-wrap:anywhere]">{p.approvalReference}</dd>
              </>
            )}
            <dt className="text-text-muted">Created by</dt>
            <dd>
              {p.createdByName ?? 'Unknown'}, {dateTime(p.createdAt)}
            </dd>
            {p.deactivatedAt && (
              <>
                <dt className="text-text-muted">Deactivated</dt>
                <dd className="[overflow-wrap:anywhere]">
                  {dateTime(p.deactivatedAt)}
                  {p.deactivationReason ? `: ${p.deactivationReason}` : ''}
                </dd>
              </>
            )}
          </dl>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">What happened</h3>
            {p.history.length === 0 ? (
              <p className="text-sm text-text-muted">Nothing has been recorded yet.</p>
            ) : (
              <ol className="space-y-3">
                {p.history.map((h) => (
                  <li key={h.id} className="flex gap-3 text-sm">
                    <span
                      aria-hidden
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-action-primary"
                    />
                    <div className="min-w-0">
                      <p className="text-text-primary">
                        {HISTORY_LABEL[h.action] ?? h.action} by {h.actorName ?? 'System'}
                      </p>
                      {h.reason && (
                        <p className="text-caption text-text-secondary [overflow-wrap:anywhere]">
                          {h.reason}
                        </p>
                      )}
                      <p className="text-caption text-text-muted">{dateTime(h.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

/* ── Deactivate ──────────────────────────────────────────────────────────────────── */

function DeactivateDialog({
  policy,
  onClose,
}: {
  policy: PlatformFeePolicyView | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    setReason('');
    setError(undefined);
  }, [policy?.id]);

  const deactivate = useMutation({
    mutationFn: (p: PlatformFeePolicyView) =>
      feePolicyApi.deactivate(p.id, { reason: reason.trim(), version: p.version }),
    onSuccess: () => {
      toast.push('Fee policy deactivated.', 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'fee-policies'] });
      onClose();
    },
    onError: (e) => {
      if (isConflict(e)) {
        // Somebody changed it first. Reload the list so the row shows what is true now.
        void qc.invalidateQueries({ queryKey: ['admin', 'fee-policies'] });
        setError(`${errorMessage(e)} The list has been reloaded. Check the policy and try again.`);
      } else setError(errorMessage(e));
    },
  });

  const tooShort = reason.trim().length < MIN_REASON;

  return (
    <Dialog open={!!policy} onClose={onClose} title="Deactivate fee policy">
      {policy && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Stop the policy <strong className="text-text-primary">{termsLabel(policy)}</strong> for{' '}
            <strong className="text-text-primary">{targetName(policy)}</strong>. New orders pay the
            normal booking fee.
          </p>
          <p className="text-sm text-text-secondary">
            Bookings already made keep the fee they were charged.
          </p>
          <Textarea
            label="Reason"
            rows={3}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(undefined);
            }}
            hint={`At least ${MIN_REASON} characters.`}
          />
          {error && (
            <p role="alert" className="text-sm text-status-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deactivate.isPending}
              disabled={tooShort}
              onClick={() => deactivate.mutate(policy)}
            >
              Deactivate
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
